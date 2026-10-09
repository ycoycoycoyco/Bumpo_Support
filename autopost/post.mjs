// Bumpo Instagram autopost. Runs on GitHub Actions every 15 minutes.
// Publishes every post in posts.json whose time has come, then records the result.
// Usage: node autopost/post.mjs [run|check]
import { readFile, writeFile } from 'node:fs/promises';

const API = 'https://graph.facebook.com/v21.0';
const FILE = new URL('./posts.json', import.meta.url);
const PAGES = 'https://ycoycoycoyco.github.io/Bumpo_Support/';
const RAW = 'https://raw.githubusercontent.com/ycoycoycoyco/Bumpo_Support/main/';
const MAX_LATE_H = 24;     // never publish a post more than this many hours late
const MAX_ATTEMPTS = 3;

const { IG_USER_ID, IG_TOKEN } = process.env;
const mode = process.argv[2] || 'run';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function graph(path, params = {}, method = 'GET') {
  const body = new URLSearchParams({ ...params, access_token: IG_TOKEN });
  const url = method === 'GET' ? `${API}/${path}?${body}` : `${API}/${path}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const json = await res.json();
  if (json.error) throw new Error(`${json.error.message} (code ${json.error.code}${json.error.error_subcode ? '/' + json.error.error_subcode : ''})`);
  return json;
}

// A bare filename means a video in the repo. Prefer GitHub Pages (serves video/mp4), fall back to raw.
async function videoUrl(v) {
  if (/^https?:/.test(v)) return v;
  const pages = PAGES + encodeURIComponent(v);
  try {
    const r = await fetch(pages, { method: 'HEAD' });
    if (r.ok && (r.headers.get('content-type') || '').startsWith('video/')) return pages;
  } catch {}
  return RAW + encodeURIComponent(v);
}

async function publish(p) {
  const video_url = await videoUrl(p.video);
  const { id: container } = await graph(`${IG_USER_ID}/media`, {
    media_type: 'REELS', video_url, caption: p.caption, share_to_feed: 'true',
  }, 'POST');
  // Instagram downloads and processes the video; wait until it is ready (up to 10 min).
  for (let i = 0; i < 60; i++) {
    await sleep(10000);
    const { status_code, status } = await graph(container, { fields: 'status_code,status' });
    if (status_code === 'FINISHED') break;
    if (status_code === 'ERROR' || status_code === 'EXPIRED') throw new Error(`video processing ${status_code}: ${status}`);
    if (i === 59) throw new Error('video processing timed out');
  }
  const { id } = await graph(`${IG_USER_ID}/media_publish`, { creation_id: container }, 'POST');
  const { permalink } = await graph(id, { fields: 'permalink' }).catch(() => ({}));
  return { id, permalink, video_url };
}

if (!IG_USER_ID || !IG_TOKEN) {
  // Not set up yet: stay quiet on the timer, but fail loudly on a manual check.
  console.log('IG_USER_ID or IG_TOKEN secret is not set yet, nothing to do.');
  process.exit(mode === 'check' ? 1 : 0);
}

if (mode === 'check') {
  const me = await graph(IG_USER_ID, { fields: 'username,followers_count,media_count' });
  const lim = await graph(`${IG_USER_ID}/content_publishing_limit`, { fields: 'quota_usage,config' }).catch(e => ({ error: e.message }));
  console.log('Connected to Instagram:', me);
  console.log('Publishing limit:', JSON.stringify(lim));
  process.exit(0);
}

const data = JSON.parse(await readFile(FILE, 'utf8'));
const now = Date.now();
let changed = false, failed = false;

for (const p of data.posts) {
  if (p.status !== 'scheduled') continue;
  const t = Date.parse(p.time);
  if (isNaN(t)) { p.status = 'failed'; p.error = 'bad time'; changed = true; continue; }
  if (t > now) continue;
  if (now - t > MAX_LATE_H * 3600e3) { p.status = 'skipped'; p.error = `more than ${MAX_LATE_H}h late`; changed = true; continue; }
  console.log(`Publishing ${p.id} (${p.time})`);
  try {
    const r = await publish(p);
    Object.assign(p, { status: 'posted', postedAt: new Date().toISOString(), mediaId: r.id, permalink: r.permalink || null });
    delete p.error;
    console.log(`  posted ${r.permalink || r.id}`);
  } catch (e) {
    p.attempts = (p.attempts || 0) + 1;
    p.error = e.message;
    if (p.attempts >= MAX_ATTEMPTS) p.status = 'failed';
    failed = true;
    console.error(`  error (attempt ${p.attempts}): ${e.message}`);
  }
  changed = true;
}

if (changed) await writeFile(FILE, JSON.stringify(data, null, 2) + '\n');
if (failed) process.exitCode = 1;   // makes the run show red in the Actions tab
