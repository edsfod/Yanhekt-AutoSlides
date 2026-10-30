import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '', getPath: () => '', getName: () => 'AutoSlides', getVersion: () => '0.0.0' } }));
vi.mock('@main/infra/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import { CourseIndexBundle, LocalCourseIndex } from '@main/platform/courseIndex/courseIndex';
import { CourseIndexUpdater } from '@main/platform/courseIndex/courseIndexUpdater';
import { PLAINTEXT_INDEX_GZ, PLAINTEXT_INDEX_JSON } from './plaintextCourseIndex';

const SAMPLE_INDEX_V1 = {
  format: 'yanhekt-session-index/v1',
  generatedAt: '2026-10-20T00:00:00Z',
  courses: [
    { id: 102, name: '数据结构', number: null, term: '2024-2025-1', teachers: [], sessions: [] },
    { id: 101, name: '线性代数', number: 'K0101', term: '2024-2025-1', teachers: ['张三'], sessions: [9002, 9001] },
    { id: 201, name: '高等数学', number: 'K0201', term: '2025-2026-1', teachers: ['李四'], sessions: [9101] },
  ],
};

describe('plaintextCourseIndex (PATCHES #4)', () => {
  let root = '';
  let bundledDir = '';
  let downloadedDir = '';

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-index-'));
    bundledDir = path.join(root, 'bundled');
    downloadedDir = path.join(root, 'downloaded');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.mkdirSync(downloadedDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reads gzipped legacy-session-index.json.gz without a passphrase', async () => {
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(SAMPLE_INDEX_V1), 'utf8'));
    fs.writeFileSync(path.join(bundledDir, PLAINTEXT_INDEX_GZ), gz);

    const bundle = new CourseIndexBundle({ dir: bundledDir, passphrase: null });
    expect(await bundle.state()).toEqual({
      ok: true,
      generatedAt: '2026-10-20T00:00:00Z',
      terms: [
        { term: '2025-2026-1', courses: 1, sessions: 1 },
        { term: '2024-2025-1', courses: 2, sessions: 2 },
      ],
    });

    expect(await bundle.term('2024-2025-1')).toEqual([
      { id: '101', name: '线性代数', number: 'K0101', teachers: ['张三'], sessionIds: ['9001', '9002'] },
      { id: '102', name: '数据结构', number: null, teachers: [], sessionIds: [] },
    ]);
  });

  it('updates LocalCourseIndex online when passphrase is null', async () => {
    fs.writeFileSync(path.join(bundledDir, PLAINTEXT_INDEX_JSON), JSON.stringify(SAMPLE_INDEX_V1));
    const index = new LocalCourseIndex({ downloadedDir, bundledDir, passphrase: null });
    expect((await index.terms()).map((t) => [t.term, t.source])).toEqual([
      ['2025-2026-1', 'bundled'],
      ['2024-2025-1', 'bundled'],
    ]);

    const newerSnapshot = {
      format: 'yanhekt-session-index/v1',
      generatedAt: '2026-10-29T03:33:36Z',
      courses: [
        ...SAMPLE_INDEX_V1.courses,
        { id: 301, name: '人工智能导论', number: 'K0301', term: '2026-2027-1', teachers: ['王五'], sessions: [9201, 9202] },
      ],
    };
    const newerBuffer = Buffer.from(JSON.stringify(newerSnapshot), 'utf8');

    const updater = new CourseIndexUpdater({
      index,
      enabled: () => false,
      currentTerm: async () => '2026-2027-1',
      fetcher: async () => newerBuffer,
    });

    expect(await updater.check()).toEqual({ ok: true, downloaded: ['2026-2027-1'] });
    expect(fs.existsSync(path.join(downloadedDir, PLAINTEXT_INDEX_GZ))).toBe(true);
    expect((await index.terms()).map((t) => [t.term, t.source])).toEqual([
      ['2026-2027-1', 'downloaded'],
      ['2025-2026-1', 'downloaded'],
      ['2024-2025-1', 'downloaded'],
    ]);
    expect((await index.byId('301'))?.name).toBe('人工智能导论');
  });
});
