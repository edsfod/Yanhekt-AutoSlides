import type { IpcServices } from '@main/ipc/types';
import { yanhektStartSeconds } from '@main/platform/yanhe2/yanhe2Twin';
import type { DownloadProgress } from '@main/video/m3u8DownloadService';

export const YANHEKT_ROOM_SCHEME = 'yanhekt-room://';

export function isYanhektRoomMarker(url: string): boolean {
  return typeof url === 'string' && url.startsWith(YANHEKT_ROOM_SCHEME);
}

/**
 * Resolve a Yanhekt 1.0 classroom camera (`room`) URL from a video object.
 * - Uses `video.room` directly when the 1.0 API returns it (`is_record_room === 1`).
 * - Falls back to replacing `/Video1.m3u8` with `/VideoRoom.m3u8` on `/vod-yhkt/`
 *   paths when `/v1/video` omits the `room` field.
 */
export function resolveYanhektRoomUrl(video?: {
  main?: string;
  vga?: string;
  room?: string;
}): string {
  const explicit = video?.room?.trim();
  if (explicit) return explicit;
  const main = video?.main?.trim() ?? '';
  if (main.includes('/vod-yhkt/') && /\/Video1\.m3u8$/i.test(main)) {
    return main.replace(/\/Video1\.m3u8$/i, '/VideoRoom.m3u8');
  }
  return '';
}

function parseRoomMarker(markerUrl: string): { courseId: string; sessionId: string } {
  const rest = markerUrl.slice(YANHEKT_ROOM_SCHEME.length);
  const slashIdx = rest.indexOf('/');
  if (slashIdx < 0) {
    return { courseId: '', sessionId: rest.trim() };
  }
  return {
    courseId: rest.slice(0, slashIdx).trim(),
    sessionId: rest.slice(slashIdx + 1).trim(),
  };
}

function findSignedInYanhe2Badge(services: IpcServices, loginToken?: string): string | null {
  const cfg = services.configService.getConfig();
  const candidates: string[] = [];

  if (loginToken) {
    const matched = cfg.accounts.find((a) => a.token === loginToken && a.badge);
    if (matched?.badge) candidates.push(matched.badge);
  }

  const sortedAccounts = [...cfg.accounts].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  for (const acc of sortedAccounts) {
    if (acc.badge && !candidates.includes(acc.badge)) {
      candidates.push(acc.badge);
    }
  }

  for (const [badge, exp] of Object.entries(cfg.yanhe2SessionExpiry ?? {})) {
    if (badge && exp > 0 && !candidates.includes(badge)) {
      candidates.push(badge);
    }
  }

  for (const badge of candidates) {
    if (services.yanhe2Service.getJwt(badge)) {
      return badge;
    }
  }
  return null;
}

/**
 * Download the `room` (classroom camera) stream when initiated from a Yanhekt 1.0
 * surface without a direct `room_url`:
 * 1. Re-checks Yanhekt 1.0 (`/v1/video` and `/v1/course/session/list`).
 * 2. Otherwise resolves the Yanhe 2.0 twin course + session and downloads its
 *    `room` MP4 stream.
 */
export async function startRoomDownloadWithFallback(
  services: IpcServices,
  downloadId: string,
  markerUrl: string,
  outputName: string,
  progressCallback: (progress: DownloadProgress) => void,
  loginToken?: string,
): Promise<string> {
  const { courseId: rawCourseId, sessionId } = parseRoomMarker(markerUrl);
  if (!sessionId) {
    throw new Error('Missing session ID for room stream download');
  }

  const info = await services.apiClient
    .getSessionDownloadInfo(sessionId, loginToken)
    .catch(() => null);

  let roomUrl = info?.session?.room_url?.trim() ?? '';
  const effectiveCourseId = rawCourseId || (info?.course?.id ? String(info.course.id) : '');

  if (!roomUrl && loginToken && effectiveCourseId) {
    const sessions = await services.apiClient
      .getCourseSessions(effectiveCourseId, loginToken)
      .catch(() => []);
    const matched = sessions.find(
      (s) => String(s.session_id) === String(sessionId) || String(s.id) === String(sessionId),
    );
    if (matched?.room_url?.trim()) {
      roomUrl = matched.room_url.trim();
    }
  }

  if (roomUrl) {
    return services.m3u8DownloadService.startDownload(
      downloadId,
      roomUrl,
      outputName,
      progressCallback,
      loginToken,
    );
  }

  const badge = findSignedInYanhe2Badge(services, loginToken);
  const numericCourseId = Number(effectiveCourseId) || info?.course?.id || 0;
  if (badge && numericCourseId > 0) {
    const twinCourse = await services.yanhe2TwinResolver.findYanhe2Course(badge, {
      courseId: numericCourseId,
    });
    if (twinCourse.kind === 'ok' && twinCourse.data) {
      const detail = await services.yanhe2Service.getCourseDetail(badge, {
        courseId: twinCourse.data.courseId,
      });
      if (detail.kind === 'ok') {
        const targetStart = yanhektStartSeconds(info?.session?.started_at ?? '');
        const targetTitle = info?.session?.title?.trim() ?? '';
        const matchedSession =
          (targetStart !== null
            ? detail.data.sessions.find((s) => s.startSeconds === targetStart)
            : undefined)
          ?? (targetTitle
            ? detail.data.sessions.find((s) => s.name.trim() === targetTitle)
            : undefined);
        if (matchedSession) {
          return services.yanhe2DownloadService.start(
            downloadId,
            badge,
            { courseId: twinCourse.data.courseId, subId: matchedSession.subId },
            'room',
            outputName,
            progressCallback,
          );
        }
      }
    }
  }

  throw new Error(
    'This session has no classroom camera (room) recording on Yanhekt 1.0 or Yanhe 2.0',
  );
}
