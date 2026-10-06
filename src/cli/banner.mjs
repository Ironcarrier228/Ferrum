// Ferrum's own start-up banner (the mascot is the same art the engine uses; the wordmark is ours).
const MASCOT = [
  " •●●:.        .:●●•",
  ":●●●●:        :●●●●:",
  ".●●●●:.:•●●•:.:●●●●.",
  " .●●●: •●●●●• :●●●.",
  " ..:••●●●●●●●●••:..",
  ".::••••●●●●●●••••::.",
  " . .:  •●●●●•  :. .",
  "    .  :●●●●:  .",
  "      .●●●●●●.",
  "       :••••:",
];
const WORDMARK = [
  "█▀▀▀▀ █▀▀▀▀ █▀▀▀█ █▀▀▀█ █   █ █▀▄▀█",
  "█▀▀▀  █▀▀▀  █▀▀▀▄ █▀▀▀▄ █   █ █ ▀ █",
  "▀     ▀▀▀▀▀ ▀   ▀ ▀   ▀ ▀▀▀▀▀ ▀   ▀",
];
const WORDMARK_ROW = 3; // first mascot row next to the wordmark
const TAGLINE = "based on OpenClaw";
const MASCOT_W = 20, GAP = 3, WIDTH = MASCOT_W + GAP + WORDMARK[0].length;

const paint = (code, s, color) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);

/** Banner as an array of lines. `color`: ANSI colours on/off. Too-narrow terminals get a two-line title. */
export function bannerLines({ color = false, columns = 80 } = {}) {
  if (columns < WIDTH) return [paint("1", "FERRUM", color), paint("2", TAGLINE, color)];
  const lines = [];
  for (let r = 0; r < MASCOT.length; r++) {
    let line = paint("38;5;209", MASCOT[r].padEnd(MASCOT_W), color);
    const w = WORDMARK[r - WORDMARK_ROW];
    if (w) line += " ".repeat(GAP) + paint("1;97", w, color);
    else if (r === WORDMARK_ROW + WORDMARK.length) line += " ".repeat(GAP) + paint("2", TAGLINE, color);
    lines.push(line.replace(/\s+$/, ""));
  }
  return lines;
}

/** Print the banner on an interactive terminal only (never into pipes, logs or tests). `FERRUM_NO_BANNER=1` turns it off. */
export function showBanner(out = process.stdout, env = process.env) {
  if (!out.isTTY || env.FERRUM_NO_BANNER) return false;
  const color = !env.NO_COLOR && env.TERM !== "dumb";
  out.write(`\n${bannerLines({ color, columns: out.columns || 80 }).join("\n")}\n\n`);
  return true;
}
