/**
 * Next.js instrumentation hook — runs once at server startup, before any
 * request is handled. We use it to quiet the built-in dev-server request
 * logging ("GET /api/... 200 in 15ms") so the console isn't flooded by the
 * TV/controller polling loop.
 *
 * Verbosity mirrors src/lib/aqua/chat.ts:
 *   DEBUG_VERBOSE=0 / unset → suppress Next.js request logs (errors still show)
 *   DEBUG_VERBOSE=1         → suppress Next.js request logs (tool/DM logs show)
 *   DEBUG_VERBOSE=2         → show everything, including request logs
 *
 * Only patches in the Node.js runtime and only in development — production
 * builds don't emit these per-request lines.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV !== "development") return;

  const v = String(process.env.DEBUG_VERBOSE || "").toLowerCase();
  const verboseLevel = v === "2" ? 2 : v === "1" || v === "true" ? 1 : 0;
  if (verboseLevel >= 2) return; // level 2: keep Next.js request logs as-is

  // Next.js 14 dev prints request lines like:
  //   "GET /api/campaigns/abc 200 in 15ms"
  //   "POST /api/join 200 in 120ms"
  // and, the FIRST few times each route is hit, per-route compile chatter:
  //   "○ Compiling /api/party ..."
  //   "✓ Compiled /api/party in 512ms (243 modules)"
  // Both are noise from the TV/controller polling loop. Lines are colorized
  // with ANSI escape codes, so strip those before testing.
  const ANSI = /\x1b\[[0-9;]*m/g;
  const requestLine = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\/\S+\s+\d{3}\s+in\s+\d+m?s\s*$/;
  const apiCompileLine = /^\s*[○✓⚠]?\s*Compil(?:ing|ed)\s+\/api\/\S*(\s|$)/;

  const isNoiseLine = (s: string) => {
    const plain = s.replace(ANSI, "").trimEnd();
    return requestLine.test(plain) || apiCompileLine.test(plain);
  };

  // Patch console.log (Next.js's primary request logger).
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    if (args.length === 1 && typeof args[0] === "string" && isNoiseLine(args[0])) {
      return; // drop the noisy polling line
    }
    originalLog.apply(console, args as unknown as [unknown, ...unknown[]]);
  };

  // Belt-and-suspenders: some Next.js versions write request lines directly to
  // stdout, bypassing console.log. Patch process.stdout.write too.
  const stdout = process.stdout;
  const originalWrite = stdout.write.bind(stdout);
  stdout.write = ((chunk: any, ...rest: unknown[]) => {
    if (typeof chunk === "string" && isNoiseLine(chunk)) {
      return true; // pretend we wrote it
    }
    return originalWrite(chunk, ...(rest as any));
  }) as typeof stdout.write;
}
