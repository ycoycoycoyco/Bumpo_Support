// Bumpo Instagram autopost on GitHub Actions.
// Publishes every post in posts.json whose time has come, then records the result.
// Usage: node autopost/post.mjs [wait|run|check]
//   wait  = stay up for a few hours, re-read posts.json every minute and publish each post on time
//           (the workflow then starts the next run itself, so GitHub's late cron no longer matters)
//   run   = publish whatever is due right now and exit
//   check = test the connection only
import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const API = 'https://graph.facebook.com/v23.0';
const FILE = new URL('./posts.json', import.meta.url);
const PAGES = 'https://ycoycoycoyco.github.io/Bumpo_Support/';
const RAW = 'https://raw.githubusercontent.com/ycoycoycoyco/Bumpo_Support/main/';
const MAX_LATE_H = 24;     // never publish a post more than this many hours late
const EARLY_MIN = 10;     // a run up to this many minutes before the slot may publish (scheduled runs are off-peak and often late)
const MAX_ATTEMPTS = 3;
const WAIT_H = 5.5;        // wait mode stays up this long (a GitHub job may run at most 6 h)
const RETRY_MIN = 10;     // after a failed attempt, wait this long before trying that post again

const { IG_TOKEN } = process.env;
let IG_USER_ID = process.env.IG_USER_ID;
const mode = process.argv[2] || 'run';
const early = mode === 'wait' ? 0 : EARLY_MIN;   // the waiting run is on time, so it never needs to post early
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

if (!IG_TOKEN) {
  // Not set up yet: stay quiet on the timer, but fail loudly on a manual check.
  console.log('IG_TOKEN secret is not set yet, nothing to do.');
  process.exit(mode === 'check' ? 1 : 0);
}

// IG_USER_ID is optional: find the Instagram account linked to the Page the token can see (once per run).
async function ensureUserId() {
  if (IG_USER_ID) return;
  const { data = [] } = await graph('me/accounts', { fields: 'name,instagram_business_account{id,username}' });
  const hit = data.find(p => p.instagram_business_account);
  if (!hit) throw new Error('No Instagram account found on the Pages this token can access.');
  IG_USER_ID = hit.instagram_business_account.id;
  console.log(`Using Instagram @${hit.instagram_business_account.username} (${IG_USER_ID}) via Page "${hit.name}"`);
}

if (mode === 'check') {
  await ensureUserId();
  const me = await graph(IG_USER_ID, { fields: 'username,followers_count,media_count' });
  const lim = await graph(`${IG_USER_ID}/content_publishing_limit`, { fields: 'quota_usage,config' }).catch(e => ({ error: e.message }));
  console.log('Connected to Instagram:', me);
  console.log('Publishing limit:', JSON.stringify(lim));
  process.exit(0);
}

const nextTry = {};   // post id -> earliest time to retry after a failure

// One pass over the queue: publish what is due, record results. Returns what happened.
async function publishDue() {
  const data = JSON.parse(await readFile(FILE, 'utf8'));
  const now = Date.now();
  let changed = false, failed = false;
  for (const p of data.posts) {
    if (p.status !== 'scheduled') continue;
    const t = Date.parse(p.time);
    if (isNaN(t)) { p.status = 'failed'; p.error = 'bad time'; changed = true; continue; }
    if (t - early * 60e3 > now) continue;
    if (now - t > MAX_LATE_H * 3600e3) { p.status = 'skipped'; p.error = `more than ${MAX_LATE_H}h late`; changed = true; continue; }
    if (nextTry[p.id] > now) continue;
    console.log(`Publishing ${p.id} (${p.time})`);
    try {
      await ensureUserId();
      const r = await publish(p);
      Object.assign(p, { status: 'posted', postedAt: new Date().toISOString(), mediaId: r.id, permalink: r.permalink || null });
      delete p.error;
      console.log(`  posted ${r.permalink || r.id}`);
    } catch (e) {
      p.attempts = (p.attempts || 0) + 1;
      p.error = e.message;
      if (p.attempts >= MAX_ATTEMPTS) p.status = 'failed';
      nextTry[p.id] = Date.now() + RETRY_MIN * 60e3;
      failed = true;
      console.error(`  error (attempt ${p.attempts}): ${e.message}`);
    }
    changed = true;
  }
  if (changed) await writeFile(FILE, JSON.stringify(data, null, 2) + '\n');
  return { changed, failed };
}

const git = cmd => execSync(`git ${cmd}`, { stdio: 'pipe' }).toString();
function saveStatus() {
  git('add autopost/posts.json');
  try { git('diff --cached --quiet'); return; } catch {}   // nothing staged
  git('commit -q -m "autopost: update post status"');
  for (let i = 0; i < 3; i++) {
    try { git('pull -q --rebase'); git('push -q'); return; } catch (e) { console.error('push failed, retrying:', e.message.split('\n')[0]); }
  }
}

if (mode === 'wait') {
  const end = Date.now() + WAIT_H * 3600e3;
  console.log(`Waiting for due posts until ${new Date(end).toISOString()}`);
  for (;;) {
    try { git('pull -q --rebase'); } catch (e) { console.error('pull failed:', e.message.split('\n')[0]); }
    const r = await publishDue().catch(e => { console.error('pass failed:', e.message); return {}; });
    if (r.changed) { try { saveStatus(); } catch (e) { console.error('save failed:', e.message.split('\n')[0]); } }
    if (Date.now() > end) break;
    await sleep(60e3);
  }
} else {
  const r = await publishDue();
  if (r.failed) process.exitCode = 1;   // makes the run show red in the Actions tab
}
