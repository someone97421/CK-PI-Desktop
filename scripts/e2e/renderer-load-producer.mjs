const chunkCount = 180;
const chunkSize = 512;
let sequence = 0;
const timer = setInterval(() => {
  sequence += 1;
  const delta = sequence === chunkCount
    ? `${"a".repeat(chunkSize)}\n\n# final-sequence-${sequence}`
    : "a".repeat(chunkSize);
  process.stdout.write(`${JSON.stringify({ sequence, delta })}\n`);
  if (sequence === chunkCount) clearInterval(timer);
}, 25);
