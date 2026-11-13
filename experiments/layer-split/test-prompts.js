// Fixed tokenized fixtures for numerical comparisons; no model preparation.
export const tests = [
  {
    name: "short",
    prompt: "What is the capital of France?",
    tokens: [
      1, 4093, 198, 1780, 314, 260, 3575, 282, 4649, 47, 2, 198, 1, 520, 9531,
      198,
    ],
    steps: 12,
  },
  {
    name: "longer",
    prompt:
      "Explain in one short sentence why the sky looks blue on a clear day.",
    tokens: [
      1, 4093, 198, 36971, 281, 582, 1890, 6330, 1701, 260, 6376, 5117, 4461,
      335, 253, 2437, 1194, 30, 2, 198, 1, 520, 9531, 198,
    ],
    steps: 12,
  },
];
