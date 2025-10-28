import * as readline from 'readline';

/**
 * 실행 전 사용자 확인(10초 카운트다운, 기본 N=계속)
 * Y/y 입력 → 중단(false 반환)
 * N/n/Enter/Timeout → 계속(true 반환)
 */
export async function promptProceedWithTimeout(
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
      // Ctrl+C 즉시 종료(관례)
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

    // 초기 표기 & 1초마다 카운트다운
    render();
    const tick = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) return;
      render();
    }, 1000);

    // 타임아웃: N으로 간주(계속)
    const timeout = setTimeout(() => {
      cleanup();
      resolve(true);
    }, seconds * 1000);
  });
}

// 사용 예시
async function main() {
  const shouldContinue = await promptProceedWithTimeout('실행을 멈추시겠습니까? (Y/N)', 10);
  if (!shouldContinue) {
    console.log('사용자 요청(Y)으로 스크립트를 중단합니다.');
    process.exit(0);
  }
  console.log('N 또는 타임아웃으로 계속 실행합니다.');
  // ...여기에 본 로직...
}

if (require.main === module) {
  // 단독 실행 시에만 동작하도록
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
