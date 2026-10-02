import assert from 'node:assert/strict';
import test from 'node:test';

import { isAllowedProxyHost } from '../server/config.js';
import { signUpstream, verifySigned } from '../server/sign.js';
import { rewritePlaylist } from '../server/stream.js';
import {
  buildLadder,
  parseVideoId,
  selectAudio,
  selectHls,
  selectHlsSource,
  selectProgressive,
} from '../server/youtube.js';

const GV = 'https://rr1---sn-abc.googlevideo.com/videoplayback?expire=1&sig=xyz';

/* ---------------------------------------------------------------- *
 * URL parsing
 * ---------------------------------------------------------------- */

test('parses every shape of YouTube reference', () => {
  const id = 'aqz-KE-bpKQ';
  const cases = [
    id,
    `  ${id}  `,
    `"${id}"`,
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&list=PL123&index=2`,
    `https://m.youtube.com/watch?v=${id}`,
    `http://www.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?t=42`,
    `https://www.youtube.com/embed/${id}`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/live/${id}`,
    `https://www.youtube-nocookie.com/embed/${id}`,
    `https://www.youtube.com/attribution_link?u=%2Fwatch%3Fv%3D${id}`,
  ];
  for (const input of cases) {
    assert.equal(parseVideoId(input), id, `failed for: ${input}`);
  }
});

test('rejects things that are not YouTube references', () => {
  for (const input of [
    '',
    '   ',
    null,
    undefined,
    123,
    'not a url',
    'https://vimeo.com/12345',
    'https://example.com/watch?v=aqz-KE-bpKQ',
    'https://www.youtube.com/watch?v=tooshort',
    'https://www.youtube.com/feed/subscriptions',
  ]) {
    assert.equal(parseVideoId(input), null, `should reject: ${input}`);
  }
});

/* ---------------------------------------------------------------- *
 * Proxy URL signing
 * ---------------------------------------------------------------- */

test('a signed url round-trips', () => {
  const verdict = verifySigned(signUpstream(GV));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.url, GV);
});

test('a tampered signature is rejected', () => {
  const signed = signUpstream(GV);
  assert.equal(verifySigned(`${signed.slice(0, -2)}xx`).reason, 'bad signature');
  assert.equal(verifySigned(signed.replace(/^./, 'z')).reason, 'bad signature');
  // A second dot makes the blob structurally invalid.
  assert.equal(verifySigned(`${signed}.extra`).reason, 'malformed signature');
  assert.equal(verifySigned('').ok, false);
  assert.equal(verifySigned(undefined).ok, false);
});

test('an expired link is rejected', () => {
  const verdict = verifySigned(signUpstream(GV, -1000));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'link expired');
});

test('the proxy is not an open relay', () => {
  // Even with a *valid* signature, only allow-listed hosts get through.
  for (const host of [
    'https://evil.example.com/steal',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost:8080/admin',
    'http://127.0.0.1/',
    'file:///etc/passwd',
    'https://youtube.com.evil.com/x',
  ]) {
    const verdict = verifySigned(signUpstream(host));
    assert.equal(verdict.ok, false, `should reject: ${host}`);
  }
});

test('host allow-listing accepts google media hosts only', () => {
  assert.equal(isAllowedProxyHost('rr1---sn-abc.googlevideo.com'), true);
  assert.equal(isAllowedProxyHost('i.ytimg.com'), true);
  assert.equal(isAllowedProxyHost('manifest.googlevideo.com'), true);
  assert.equal(isAllowedProxyHost('googlevideo.com'), true);
  assert.equal(isAllowedProxyHost('evil.com'), false);
  assert.equal(isAllowedProxyHost(''), false);
  assert.equal(isAllowedProxyHost(null), false);
});

/* ---------------------------------------------------------------- *
 * Format selection
 * ---------------------------------------------------------------- */

const FORMATS = [
  // progressive (muxed) - the ideal single-file stream
  { format_id: '18', url: 'https://g/18', vcodec: 'avc1', acodec: 'mp4a', height: 360, fps: 30, ext: 'mp4', filesize: 10, protocol: 'https' },
  { format_id: '22', url: 'https://g/22', vcodec: 'avc1', acodec: 'mp4a', height: 720, fps: 30, ext: 'mp4', filesize: 20, protocol: 'https' },
  // video only - unusable on its own
  { format_id: '137', url: 'https://g/137', vcodec: 'avc1', acodec: 'none', height: 1080, protocol: 'https' },
  // audio only
  { format_id: '140', url: 'https://g/140', vcodec: 'none', acodec: 'mp4a', height: null, abr: 128, ext: 'm4a', protocol: 'https' },
  { format_id: '251', url: 'https://g/251', vcodec: 'none', acodec: 'opus', height: null, abr: 160, ext: 'webm', protocol: 'https' },
  // HLS variants
  { format_id: '301', url: 'https://g/301.m3u8', vcodec: 'avc1', acodec: 'none', height: 1080, protocol: 'm3u8_native' },
];

test('picks the best progressive stream under the cap', () => {
  assert.equal(selectProgressive(FORMATS, { maxHeight: 1080 }).formatId, '22');
  assert.equal(selectProgressive(FORMATS, { maxHeight: 480 }).formatId, '18');
});

test('falls back to HLS when no progressive stream qualifies', () => {
  const onlyDash = FORMATS.filter((f) => f.acodec === 'none' || f.vcodec === 'none');
  assert.equal(selectProgressive(onlyDash, { maxHeight: 1080 }), null);

  const hls = selectHls(FORMATS, { maxHeight: 1080 });
  assert.equal(hls.formatId, '301');
  assert.equal(hls.height, 1080);
});

/* ---------------------------------------------------------------- *
 * HLS audio (regression: video played silently)
 * ---------------------------------------------------------------- */

test('uses the master playlist when HLS variants are video-only', () => {
  // Every HLS variant YouTube publishes has acodec "none". Pointing a player
  // at one of those gives a picture with no sound; only the master playlist
  // carries the EXT-X-MEDIA audio groups.
  const formats = [
    {
      format_id: '312',
      url: 'https://m/variant1080.m3u8',
      manifest_url: 'https://m/master.m3u8',
      vcodec: 'avc1.64002A',
      acodec: 'none',
      height: 1080,
      protocol: 'm3u8_native',
    },
    {
      format_id: '311',
      url: 'https://m/variant720.m3u8',
      manifest_url: 'https://m/master.m3u8',
      vcodec: 'avc1.4D4020',
      acodec: 'none',
      height: 720,
      protocol: 'm3u8_native',
    },
  ];

  const source = selectHlsSource(formats, { maxHeight: 1080 });
  assert.equal(source.master, true, 'did not fall back to the master playlist');
  assert.equal(source.url, 'https://m/master.m3u8', 'wrong master url');
  assert.equal(source.height, 1080);
});

test('prefers a muxed HLS variant over the master when one exists', () => {
  const formats = [
    { format_id: 'a', url: 'https://m/v.m3u8', manifest_url: 'https://m/master.m3u8', vcodec: 'avc1', acodec: 'mp4a', height: 720, protocol: 'm3u8_native' },
    { format_id: 'b', url: 'https://m/v2.m3u8', manifest_url: 'https://m/master.m3u8', vcodec: 'avc1', acodec: 'none', height: 2160, protocol: 'm3u8_native' },
  ];
  const source = selectHlsSource(formats, { maxHeight: 1080 });
  assert.equal(source.master, false);
  assert.equal(source.url, 'https://m/v.m3u8');
});

test('selectHlsSource returns null when there is no HLS at all', () => {
  assert.equal(selectHlsSource([], { maxHeight: 1080 }), null);
  assert.equal(selectHlsSource(FORMATS.filter((f) => f.protocol !== 'm3u8_native')), null);
});

test('picks the best audio-only rendition', () => {  assert.equal(selectAudio(FORMATS).formatId, '251');
  assert.equal(selectAudio(FORMATS, { maxBitrate: 128 }).formatId, '140');
});

test('never returns a stream above the requested ceiling', () => {
  const chosen = selectProgressive(
    [{ ...FORMATS[1], height: 2160 }],
    { maxHeight: 1080 },
  );
  // Nothing qualifies, so it degrades to the best available rather than
  // silently lying about the ceiling.
  assert.equal(chosen.height, 2160);
});

test('the quality ladder has no bogus entries', () => {  const ladder = buildLadder(
    [
      ...FORMATS,
      // audio-only, resolution string instead of height - used to leak through
      { format_id: '249', url: 'https://g/249', vcodec: 'none', acodec: 'opus', resolution: 'audio only', abr: 50 },
    ],
    { maxHeight: 1080 },
  );
  const labels = ladder.map((q) => q.label);
  assert.ok(!labels.includes('audio onlyp'), `leaked bogus label: ${labels.join(', ')}`);
  assert.ok(!labels.some((l) => l.endsWith('NaNp')));
  assert.ok(labels.includes('AUDIO 50k'));
  assert.ok(labels.includes('720p'));
});

/* ---------------------------------------------------------------- *
 * Quality ceiling
 * ---------------------------------------------------------------- */

test('quality 0 / auto means the best available, not 144p', async () => {
  // Regression: clampQuality() used to floor "auto" at 144, which silently
  // capped every default request to the worst rendition.
  const { clampQuality } = await import('../server/resolver.js');
  const { config } = await import('../server/config.js');

  const original = config.maxQuality;
  try {
    config.maxQuality = 1080;
    for (const requested of [0, 'auto', '', undefined, null, 'nonsense', -1, NaN]) {
      assert.equal(clampQuality(requested), 1080, `auto mishandled: ${requested}`);
    }

    // An explicit request is honoured, and never exceeds the ceiling.
    assert.equal(clampQuality(360), 360);
    assert.equal(clampQuality('480'), 480);
    assert.equal(clampQuality(2160), 1080, 'request above the ceiling was not capped');

    // Nonsense below the floor is lifted to the lowest sane rung.
    assert.equal(clampQuality(10), 144);

    // A lower configured ceiling wins.
    config.maxQuality = 480;
    assert.equal(clampQuality(0), 480);
    assert.equal(clampQuality(1080), 480);
  } finally {
    config.maxQuality = original;
  }
});

test('an off-ladder MAX_QUALITY is still bounded', async () => {
  const { clampQuality } = await import('../server/resolver.js');
  const { config } = await import('../server/config.js');

  const original = config.maxQuality;
  try {
    config.maxQuality = 99999;
    assert.equal(clampQuality(0), 2160, 'absurd ceiling was not clamped to 2160');
    config.maxQuality = 1;
    assert.equal(clampQuality(0), 144, 'absurdly low ceiling was not lifted to 144');
    config.maxQuality = 'nonsense';
    assert.equal(clampQuality(0), 1080, 'unparseable ceiling did not fall back to 1080');
  } finally {
    config.maxQuality = original;
  }
});

/* ---------------------------------------------------------------- *
 * End to end (skipped when there is no network / no resolver)
 * ---------------------------------------------------------------- */

test('resolves a real video to a playable stream', async (t) => {
  const { resolveVideo, probeYtdlp } = await import('../server/resolver.js');
  const probe = await probeYtdlp();

  if (!probe.ok) {
    t.skip('yt-dlp is not installed');
    return;
  }

  // Big Buck Bunny is permanently public, so this stays stable.
  const video = await resolveVideo('aqz-KE-bpKQ', { quality: 1080 });

  // The important assertion: we must NOT have silently degraded to oEmbed.
  // A crash anywhere in normalisation looks identical to "no resolver", which
  // is how a plain ReferenceError in normalize() hid for so long.
  assert.equal(
    video.degraded,
    false,
    `degraded to oEmbed - ytdlp: ${video.source}. A resolver error is being swallowed.`,
  );
  assert.equal(video.source, 'ytdlp');
  assert.equal(video.playable, true);
  assert.equal(video.title.length > 0, true);
  assert.equal(video.duration > 0, true);

  // Thumbnails and streams must be same-origin so the browser can use them.
  assert.match(video.thumbnail, /^\/api\/thumb\?/);
  assert.ok(video.streams.hls || video.streams.progressive, 'no playable stream');
  for (const stream of [video.streams.hls, video.streams.progressive, video.streams.audio]) {
    if (stream) assert.match(stream.url, /^\/api\/(proxy|hls)\?s=/, 'stream is not proxied');
  }

  // A signed stream link must verify.
  if (video.streams.progressive) {
    const signed = video.streams.progressive.url.split('s=')[1];
    assert.equal(verifySigned(signed).ok, true);
  }

  assert.ok(video.ladder.length > 0, 'empty quality ladder');
  assert.equal(video.quality, 1080, 'quality was not honoured');
});

/* ---------------------------------------------------------------- *
 * HLS playlist rewriting
 * ---------------------------------------------------------------- */

test('rewrites segment and variant URIs into signed proxy links', () => {
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:9.0,',
    'seg1.ts',
    '#EXTINF:9.0,',
    'https://other.googlevideo.com/seg2.ts',
    '#EXT-X-ENDLIST',
  ].join('\n');

  const out = rewritePlaylist(playlist, new URL('https://rr1---sn-x.googlevideo.com/hls/index.m3u8'));
  const lines = out.split('\n');

  assert.equal(lines[0], '#EXTM3U');
  assert.equal(lines[2], '#EXT-X-TARGETDURATION:10');
  assert.ok(lines[3].includes('URI="/api/proxy?s='), `EXT-X-MAP not rewritten: ${lines[3]}`);
  assert.ok(lines[5].startsWith('/api/proxy?s='), `relative segment not rewritten: ${lines[5]}`);
  assert.ok(lines[7].startsWith('/api/proxy?s='), `absolute segment not rewritten: ${lines[7]}`);
  assert.equal(lines[8], '#EXT-X-ENDLIST');

  // Every rewritten link must survive signature verification.
  for (const line of lines) {
    const match = line.match(/\/api\/proxy\?s=([^"]+)/);
    if (match) assert.equal(verifySigned(match[1]).ok, true);
  }
});

test('rewrites nested variant playlists to the playlist endpoint', () => {
  const master = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=640x360', 'low/index.m3u8'].join('\n');
  const out = rewritePlaylist(master, new URL('https://rr1---sn-x.googlevideo.com/hls/master.m3u8'));
  assert.ok(out.includes('/api/hls?s='), out);
});

test('the quality ceiling is enforced inside the signed payload', () => {
  // Host must be allow-listed, so use a real one rather than a shorthand.
  const signed = signUpstream('https://rr1---sn-x.googlevideo.com/hls/master.m3u8', 60_000, {
    maxHeight: 1080,
  });
  const verdict = verifySigned(signed);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.meta.maxHeight, 1080, 'ceiling was not carried in the signature');
});

test('a master playlist is trimmed to the signed ceiling, audio kept', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="233",URI="audio233.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,RESOLUTION=1920x1080,AUDIO="233"',
    'v1080.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2,RESOLUTION=2560x1440,AUDIO="233"',
    'v1440.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=3,RESOLUTION=3840x2160,AUDIO="233"',
    'v2160.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=4,RESOLUTION=640x360,AUDIO="233"',
    'v360.m3u8',
  ].join('\n');

  const base = new URL('https://m/master.m3u8');
  const out = rewritePlaylist(master, base, { maxHeight: 1080 });
  const lines = out.split('\n');

  // URI lines are rewritten into signed links, so assert on the tags, not on
  // the original file names.
  const kept = [...out.matchAll(/RESOLUTION=(\d+)x(\d+)/g)].map((m) => Number(m[2]));
  assert.deepEqual(kept, [1080, 360], `wrong variants survived: ${kept.join(',')}`);

  // Every STREAM-INF must still be followed by exactly one URI line, otherwise
  // hls.js pairs the wrong playlist with the wrong tag.
  const streamInfCount = (out.match(/#EXT-X-STREAM-INF/g) || []).length;
  const uriLines = lines.filter((l) => l.startsWith('/api/hls?s=') && !l.includes('TYPE=')).length;
  assert.equal(streamInfCount, 2, 'expected two surviving variants');
  assert.ok(uriLines >= 2, 'variant URIs were lost while filtering');

  // Dropping the audio group is exactly what makes the player go silent.
  assert.ok(out.includes('TYPE=AUDIO'), 'audio group was dropped');
  assert.ok(/TYPE=AUDIO[^\n]*URI="\/api\/hls\?s=/.test(out), 'audio URI was not proxied');
});

test('without a ceiling the master playlist is left alone', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:RESOLUTION=3840x2160',
    'v2160.m3u8',
  ].join('\n');
  const out = rewritePlaylist(master, new URL('https://m/master.m3u8'), { maxHeight: 0 });
  const kept = [...out.matchAll(/RESOLUTION=(\d+)x(\d+)/g)].map((m) => Number(m[2]));
  assert.deepEqual(kept, [2160], 'unfiltered playlist lost a variant');
  assert.ok(out.includes('/api/hls?s='));
});
