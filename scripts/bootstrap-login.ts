import 'dotenv/config';
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

(async () => {
  const userDataDir = process.env.USER_DATA_DIR!;
  if (!userDataDir) {
    console.error('ERROR: USER_DATA_DIR가 .env에 설정되어 있지 않습니다.');
    process.exit(1);
  }

  // userDataDir 폴더가 없으면 생성 (Playwright가 자동으로 파일을 만들긴 하지만 폴더가 없을 경우 대비)
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  console.log('Chrome을 띄워 구글 계정으로 로그인하세요. 로그인 후 창을 닫으면 세션이 저장됩니다.');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  });

  try {
    const page = await ctx.newPage();
    await page.goto('https://accounts.google.com/', { waitUntil: 'domcontentloaded' });
    console.log('브라우저가 열렸습니다. 로그인 완료 후 창을 직접 닫으세요.');
    // 사용자가 수동으로 로그인 하고 창을 닫을 때까지 유지
  } catch (err) {
    console.error('Bootstrap login 중 오류:', err);
    await ctx.close();
    process.exit(1);
  }
})();
