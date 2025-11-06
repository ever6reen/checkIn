import 'dotenv/config';
import { chromium, Page, Frame, Locator, Dialog } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const SHEET_URL = process.env.SHEET_URL!;
const USER_DATA_DIR = process.env.USER_DATA_DIR!;
const OBJECT_ALT = (process.env.OBJECT_ALT ?? '').trim();
const CONFIRM_TIMEOUT_MS = Number(process.env.CONFIRM_TIMEOUT_MS ?? '15000');

if (!SHEET_URL || !USER_DATA_DIR || !OBJECT_ALT) {
  console.error('ERROR: .env에 SHEET_URL, USER_DATA_DIR, OBJECT_ALT를 모두 설정하세요.');
  process.exit(1);
}

type Scope = Page | Frame;

// ===== 실행 전 확인 프롬프트(카운트다운) =====
/**
 * Y/y → 중단(false), N/n/Enter/시간초과 → 계속(true)
 */
async function promptProceedWithTimeout(
  question = '실행을 멈추시겠습니까? (Y/N)',
  seconds = 10
): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    readline.emitKeypressEvents(process.stdin, rl);

    const isTTY = process.stdin.isTTY;
    if (isTTY) process.stdin.setRawMode?.(true);

    let remaining = seconds;

    const render = () => {
      const n = String(remaining).padStart(2, ' ');
      process.stdout.write(`\r${question}  |  자동 계속까지: ${n}초   `);
    };

    const cleanup = () => {
      clearInterval(tick);
      clearTimeout(timeout);
      process.stdout.write('\n');
      if (isTTY) process.stdin.setRawMode?.(false);
      rl.close();
      process.stdin.removeListener('keypress', onKey);
    };

    const onKey = (_str: string, key?: readline.Key) => {
      const ch = _str?.toLowerCase?.();
      if (key?.ctrl && key.name === 'c') {
        cleanup();
        process.exit(130);
      }
      if (ch === 'y') {
        cleanup();
        return resolve(false); // 중단
      }
      if (ch === 'n' || key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        return resolve(true); // 계속
      }
    };

    process.stdin.on('keypress', onKey);

    render();
    const tick = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) render();
    }, 1000);

    const timeout = setTimeout(() => {
      cleanup();
      resolve(true); // 타임아웃은 계속
    }, seconds * 1000);
  });
}

// ===== 유틸 =====
function ts() {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
}
function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

// ===== 스크린샷 경로(전역 통일) =====
const SCREENSHOT_DIR = path.resolve(process.env.SCREENSHOT_DIR ?? path.join(process.cwd(), 'screenshots'));
ensureDir(SCREENSHOT_DIR);
function ssPath(tag: string) {
  return path.join(SCREENSHOT_DIR, `${ts()}_${tag}.png`);
}

// ===== KST 주말 가드 =====
function isKstWeekend(): boolean {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    weekday: 'short',
  }).format(new Date()); // 'Sat' | 'Sun' | ...
  return weekday === 'Sat' || weekday === 'Sun';
}
function kstNowString(): string {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'full',
    timeStyle: 'medium',
  }).format(new Date());
}

// ===== aria-label 매칭 overlay 찾기 =====
async function resolveScopeWithAlt(page: Page, alt: string, maxWait = 20000): Promise<Scope> {
  const hasAltOverlay = async (s: Scope) => {
    const ov = s.locator(
      `div.waffle-borderless-embedded-object-overlay[aria-label="${alt}"],` +
      `div.waffle-borderless-embedded-object-overlay[aria-label*="${alt}"]`
    );
    return (await ov.count().catch(() => 0)) > 0;
  };

  if (await hasAltOverlay(page)) return page;
  for (const f of page.frames()) if (await hasAltOverlay(f)) return f;

  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await page.waitForTimeout(500);
    if (await hasAltOverlay(page)) return page;
    for (const f of page.frames()) if (await hasAltOverlay(f)) return f;
  }
  throw new Error(`"${alt}" aria-label을 가진 overlay를 찾지 못했습니다.`);
}

// ===== 팝업 surface 대기 (가장 위에 뜬 visible surface 선택) =====
async function waitForDialogSurface(scope: Scope, timeoutMs: number): Promise<Locator> {
  const surfaces = scope.locator('.javascriptMaterialdesignGm3WizDialog-dialog__surface');
  await surfaces.last().waitFor({ state: 'visible', timeout: timeoutMs });
  return surfaces.filter({ has: scope.locator(':scope') }).last();
}

// ===== ripple 포함 “취소” 버튼만 클릭 (surface 내부 한정) =====
async function clickCancelIfPresent(scope: Scope, page: Page, timeoutMs = 10000): Promise<boolean> {
  let surface: Locator;
  try {
    surface = await waitForDialogSurface(scope, timeoutMs);
  } catch {
    console.log('[취소] surface 미등장 → 스킵');
    return false;
  }

  const primaryCancel = surface
    .locator('[role="button"]')
    .filter({ has: surface.locator('span.javascriptMaterialdesignGm3WizRipple-ripple') })
    .filter({ hasText: /(^|\s)(취소|Cancel)(\s|$)/i });

  const fallbackCancelA = surface
    .locator('button:has(span.javascriptMaterialdesignGm3WizRipple-ripple)')
    .filter({ hasText: /(^|\s)(취소|Cancel)(\s|$)/i });

  const fallbackCancelB = surface.locator(
    [
      '[role="button"][aria-label*="취소" i]',
      '[role="button"][aria-label*="cancel" i]',
      'button[aria-label*="취소" i]',
      'button[aria-label*="cancel" i]',
    ].join(',')
  ).filter({ has: surface.locator('span.javascriptMaterialdesignGm3WizRipple-ripple') });

  const candidates = [primaryCancel, fallbackCancelA, fallbackCancelB];
  let btn: Locator | null = null;

  for (const loc of candidates) {
    if (await loc.count().catch(() => 0)) {
      btn = loc.first();
      break;
    }
  }

  if (!btn) {
    console.log('[취소] 팝업 내부 > 취소 버튼 없음 → 스킵');
    return false;
  }

  const fullShot = ssPath('before_cancel');
  await page.screenshot({ path: fullShot, fullPage: true }).catch(() => {});
  console.log(`스크린샷 저장(취소 직전, 풀페이지): ${fullShot}`);

  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 2000 });
  await surface.waitFor({ state: 'detached', timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(300);
  console.log('[취소] 팝업 내부 > 취소 버튼 클릭 완료');
  return true;
}

// ===== surface 뜬 뒤 확인 버튼 클릭 (OK / 확인) =====
type DialogHandleResult =
  | 'native-accepted'
  | 'dom-confirmed'
  | 'dom-canceled'
  | 'dom-no-surface'
  | 'dom-error'
  | 'timed-out';

async function waitAndConfirm(scope: Scope, page: Page, timeoutMs: number): Promise<DialogHandleResult> {
  let nativeAccepted = false;
  let domConfirmed = false;
  let domCanceled = false;
  let domNoSurface = false;
  let domErrored = false;

  const nativeDialogP = new Promise<void>((resolve) => {
    const handler = async (dialog: Dialog) => {
      try {
        await dialog.accept();
        nativeAccepted = true;
        console.log('[확인] 네이티브 dialog.accept() 완료');
      } catch (err) {
        console.warn('[확인] 네이티브 dialog.accept() 중 오류:', err);
      } finally {
        resolve();
      }
    };
    page.once('dialog', handler);
    setTimeout(() => resolve(), timeoutMs);
  });

  const domP = (async () => {
    let surface: Locator;
    try {
      surface = await waitForDialogSurface(scope, timeoutMs);
    } catch {
      domNoSurface = true;
      return;
    }

    const canceled = await clickCancelIfPresent(scope, page, Math.min(5000, timeoutMs)).catch(() => false);
    if (canceled) {
      domCanceled = true;
      console.log('[확인] 취소 클릭 성공 → 확인 클릭 단계 스킵');
      return;
    }

    const okBtnPrimary = surface.getByRole('button', { name: /(^|\s)(확인|OK)(\s|$)/i });
    const okBtnFallback = surface.locator('button, [role="button"]').filter({
      hasText: /(^|\s)(확인|OK)(\s|$)/i,
    });
    const okCandidates = [okBtnPrimary, okBtnFallback];

    let okBtn: Locator | null = null;
    for (const loc of okCandidates) {
      if (await loc.count().catch(() => 0)) {
        okBtn = loc.first();
        break;
      }
    }

    if (!okBtn) {
      domNoSurface = true;
      console.log('[확인] (surface 내부) 확인 버튼 없음 → 스킵');
      return;
    }

    const fullShot = ssPath('before_confirm');
    await page.screenshot({ path: fullShot, fullPage: true }).catch(() => {});
    console.log(`스크린샷 저장(확인 직전, 풀페이지): ${fullShot}`);

    await okBtn.scrollIntoViewIfNeeded().catch(() => {});
    await okBtn.click({ timeout: 2000 });
    domConfirmed = true;
    console.log('[확인] (surface 내부) 버튼 클릭 완료');
  })().catch((err) => {
    domErrored = true;
    console.warn('[확인] DOM 팝업 처리 중 오류:', err);
  });

  await Promise.race([Promise.allSettled([nativeDialogP, domP]), new Promise((r) => setTimeout(r, timeoutMs))]);
  await Promise.allSettled([nativeDialogP, domP]);

  if (nativeAccepted) return 'native-accepted';
  if (domConfirmed) return 'dom-confirmed';
  if (domCanceled) return 'dom-canceled';
  if (domNoSurface) return 'dom-no-surface';
  if (domErrored) return 'dom-error';
  return 'timed-out';
}

// ===== 메인 실행 =====
(async () => {
  /* // --- 주말(토/일, KST) 차단 ---
  if (isKstWeekend()) {
    console.log(`[KST ${kstNowString()}] 주말(토/일) 감지 → 스크립트 실행하지 않고 종료합니다.`);
    process.exit(0);
  } */
  if (!fs.existsSync(USER_DATA_DIR)) {
    console.error(`USER_DATA_DIR가 없습니다: ${USER_DATA_DIR}`);
    console.error('먼저 npm run login으로 세션을 생성하세요.');
    process.exit(1);
  }

  // --- 실행 전 사용자 확인 (10초 후 자동 계속) ---
  const shouldContinue = await promptProceedWithTimeout('실행을 멈추시겠습니까? (Y/N)', 10);
  if (!shouldContinue) {
    console.log('사용자 요청(Y)으로 스크립트를 중단합니다.');
    process.exit(0);
  }

  console.log('스크립트를 실행합니다.');

  const ctx = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await ctx.newPage();
    page.setDefaultTimeout(20000);

    await page.goto(SHEET_URL, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await page.waitForTimeout(3000);

    const scope = await resolveScopeWithAlt(page, OBJECT_ALT);

    const overlay = scope
      .locator(
        `div.waffle-borderless-embedded-object-overlay[aria-label="${OBJECT_ALT}"],` +
        `div.waffle-borderless-embedded-object-overlay[aria-label*="${OBJECT_ALT}"]`
      )
      .first();
    await overlay.waitFor({ state: 'visible', timeout: 10000 });

    const container = overlay.locator('> div.waffle-borderless-embedded-object-container').first();
    const target = (await container.count()) > 0 ? container : overlay;
    await target.scrollIntoViewIfNeeded();

    try {
      await target.click({ delay: 60 });
    } catch {
      const box = await target.boundingBox();
      if (!box) throw new Error('타겟 요소의 boundingBox를 얻지 못했습니다.');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 60 });
    }

    // 첫 상황 기록용 스크린샷
    const firstShot = ssPath('before_any');
    await page.screenshot({ path: firstShot, fullPage: true }).catch(() => {});
    console.log(`스크린샷 저장(클릭 직후): ${firstShot}`);

    // 팝업 처리 (취소 우선, surface 내부 한정)
    const dialogResult = await waitAndConfirm(scope, page, CONFIRM_TIMEOUT_MS);

    await page.waitForTimeout(800);
    switch (dialogResult) {
      case 'native-accepted':
        console.log('클릭 및 팝업 처리 완료! (네이티브 확인)');
        break;
      case 'dom-confirmed':
        console.log('클릭 및 팝업 처리 완료! (확인 버튼 클릭)');
        break;
      case 'dom-canceled':
        console.log('클릭 및 팝업 처리 완료! (취소 버튼 클릭)');
        break;
      case 'dom-no-surface':
        console.log('클릭 완료! (팝업 surface 없음)');
        break;
      case 'dom-error':
        console.log('클릭 완료! (팝업 처리 중 오류 감지)');
        break;
      default:
        console.log('클릭 완료! (팝업 탐색 시간 초과)');
        break;
    }
    await ctx.close();
  } catch (err) {
    console.error('실행 중 오류:', err);
    await ctx.close();
    process.exit(1);
  }
})();
