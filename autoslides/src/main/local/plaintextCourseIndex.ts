import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { appUserAgent } from '@main/infra/appUserAgent';
import { createLogger } from '@main/infra/logger';
import {
  CLIENT_MANIFEST_FORMAT,
  sha256Hex,
  type ClientManifest,
  type ClientTerm,
  type TermCourse,
} from '@main/platform/courseIndex/clientIndex';
import type { LocalCourseIndex } from '@main/platform/courseIndex/courseIndex';
import type { CourseIndexUpdateResult } from '@main/platform/courseIndex/courseIndexUpdater';

const log = createLogger('PlaintextCourseIndex');

export const PLAINTEXT_INDEX_GZ = 'legacy-session-index.json.gz';
export const PLAINTEXT_INDEX_JSON = 'legacy-session-index.json';

const FORK_INDEX_URL = 'https://github.com/edsfod/Yanhekt-AutoSlides/releases/download/index/legacy-session-index.json.gz';
const REFINE_INDEX_URL = 'https://github.com/1whoarei1/yanhe-refine/releases/latest/download/legacy-session-index.json';
const PROXY_PREFIX = 'https://gh-proxy.org/';
const FETCH_TIMEOUT_MS = 60_000;

interface RawPlaintextCourse {
  id?: unknown;
  name?: unknown;
  number?: unknown;
  term?: unknown;
  teachers?: unknown;
  sessions?: unknown;
}

interface RawPlaintextIndex {
  format?: unknown;
  generatedAt?: unknown;
  courses?: unknown;
}

export interface ParsedPlaintextIndex {
  generatedAt: string;
  manifest: ClientManifest;
  present: Map<string, ClientTerm>;
  terms: Map<string, TermCourse[]>;
}

function isGzipBuffer(bytes: Buffer): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export function parsePlaintextIndexBuffer(bytes: Buffer): ParsedPlaintextIndex {
  const rawBytes = isGzipBuffer(bytes) ? zlib.gunzipSync(bytes) : bytes;
  const parsed = JSON.parse(rawBytes.toString('utf8')) as RawPlaintextIndex;
  if (!parsed || parsed.format !== 'yanhekt-session-index/v1' || !Array.isArray(parsed.courses)) {
    throw new Error('unsupported plaintext session index format');
  }
  const generatedAt = typeof parsed.generatedAt === 'string' && parsed.generatedAt
    ? parsed.generatedAt
    : new Date(0).toISOString();

  const terms = new Map<string, TermCourse[]>();
  for (const item of parsed.courses as RawPlaintextCourse[]) {
    if (!item || typeof item !== 'object') continue;
    const term = typeof item.term === 'string' ? item.term.trim() : '';
    if (!/^\d{4}-\d{4}-[12]$/.test(term)) continue;
    const idNum = Number(item.id);
    if (!Number.isInteger(idNum) || idNum <= 0) continue;
    const name = String(item.name ?? '').trim();
    if (!name) continue;
    const number = item.number == null || String(item.number).trim() === '' ? null : String(item.number).trim();
    const teachers = Array.isArray(item.teachers)
      ? item.teachers.map((t) => String(t ?? '').trim()).filter(Boolean)
      : [];
    const sessionIds = Array.isArray(item.sessions)
      ? [...new Set(
        item.sessions
          .map((s) => Number(s))
          .filter((n) => Number.isInteger(n) && n > 0)
          .sort((a, b) => a - b)
          .map(String),
      )]
      : [];
    let list = terms.get(term);
    if (!list) {
      list = [];
      terms.set(term, list);
    }
    list.push({ id: String(idNum), name, number, teachers, sessionIds });
  }

  const present = new Map<string, ClientTerm>();
  const sortedTerms = [...terms.keys()].sort((a, b) => b.localeCompare(a));
  for (const term of sortedTerms) {
    const list = terms.get(term)!;
    list.sort((a, b) => Number(a.id) - Number(b.id));
    const serialized = Buffer.from(JSON.stringify(list), 'utf8');
    const digest = sha256Hex(serialized);
    const sessions = list.reduce((sum, c) => sum + c.sessionIds.length, 0);
    present.set(term, {
      term,
      asset: PLAINTEXT_INDEX_GZ,
      bytes: serialized.length,
      assetSha256: digest,
      sha256: digest,
      courses: list.length,
      sessions,
    });
  }

  const manifest: ClientManifest = {
    format: CLIENT_MANIFEST_FORMAT,
    generatedAt,
    passphraseId: 'plaintext',
    terms: [...present.values()],
  };

  return { generatedAt, manifest, present, terms };
}

export async function openPlaintextCourseIndex(dir: string): Promise<ParsedPlaintextIndex | null> {
  for (const fileName of [PLAINTEXT_INDEX_GZ, PLAINTEXT_INDEX_JSON]) {
    const filePath = path.join(dir, fileName);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(filePath);
    } catch {
      continue;
    }
    try {
      return parsePlaintextIndexBuffer(bytes);
    } catch (error) {
      log.warn(`failed to parse ${fileName} in ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return null;
}

type Fetcher = (url: string) => Promise<Buffer>;

async function defaultFetcher(url: string): Promise<Buffer> {
  const res = await fetch(url, {
    headers: { 'User-Agent': appUserAgent() },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchWithProxy(url: string, fetcher: Fetcher): Promise<Buffer> {
  try {
    return await fetcher(url);
  } catch (error) {
    log.debug(`direct fetch failed for ${url} (${error instanceof Error ? error.message : String(error)}); trying proxy`);
    return await fetcher(PROXY_PREFIX + url);
  }
}

export async function updatePlaintextCourseIndex(
  index: LocalCourseIndex,
  fetcher: Fetcher = defaultFetcher,
  currentTerm?: () => Promise<string | null>,
): Promise<CourseIndexUpdateResult> {
  const candidates: Array<{ parsed: ParsedPlaintextIndex; bytes: Buffer }> = [];
  const errors: string[] = [];

  for (const url of [FORK_INDEX_URL, REFINE_INDEX_URL]) {
    try {
      const bytes = await fetchWithProxy(url, fetcher);
      const parsed = parsePlaintextIndexBuffer(bytes);
      candidates.push({ parsed, bytes });
    } catch (error) {
      errors.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (candidates.length === 0) {
    return { ok: false, error: errors.join('; ') || 'failed to fetch plaintext course index' };
  }

  candidates.sort((a, b) => b.parsed.generatedAt.localeCompare(a.parsed.generatedAt));
  const best = candidates[0];
  const current = currentTerm ? await currentTerm() : null;
  const wanted = best.parsed.manifest.terms.filter((t) => !current || t.term <= current);

  const downloaded: string[] = [];
  for (const t of wanted) {
    const held = await index.heldEntry(t.term);
    if (!held || held.assetSha256 !== t.assetSha256) {
      downloaded.push(t.term);
    }
  }

  const heldGeneratedAt = await index.generatedAt();
  if (downloaded.length > 0 || !heldGeneratedAt || best.parsed.generatedAt > heldGeneratedAt) {
    await fs.mkdir(index.downloadedDir, { recursive: true });
    const gzBytes = isGzipBuffer(best.bytes) ? best.bytes : zlib.gzipSync(best.bytes, { level: 9 });
    const target = path.join(index.downloadedDir, PLAINTEXT_INDEX_GZ);
    const tmp = `${target}.tmp`;
    await fs.writeFile(tmp, gzBytes);
    await fs.rename(tmp, target);
    index.reset();
  }

  return { ok: true, downloaded };
}
