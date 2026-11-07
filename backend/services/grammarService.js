"use strict";
/*
 * Grammar, spelling, punctuation and style checker (the "Grammarly" half of the Plagiarism & Grammar page).
 *
 * Engine 1 (default): LanguageTool, an open-source rule engine with thousands of grammar / spelling / punctuation / style rules.
 *   LANGUAGETOOL_URL        default https://api.languagetool.org/v2/check   (point it at your own server for no limits:
 *                           docker run -p 8010:8010 erikvl87/languagetool  ->  http://localhost:8010/v2/check)
 *   LANGUAGETOOL_USERNAME / LANGUAGETOOL_API_KEY   optional, for LanguageTool Premium
 * Engine 2 (automatic fallback when LanguageTool is unreachable): a built-in rule set (spelling list, repeated words, a/an,
 *   spacing, capitalisation, wordiness, long sentences), so the page keeps working offline.
 *
 * Every issue is { id, offset, length, original, message, category, replacements[], rule } with offsets into the text sent.
 */

const LT_URL = () => String(process.env.LANGUAGETOOL_URL || "https://api.languagetool.org/v2/check");
const MAX_CHARS = 30000;
const MIN_WORDS = 3;
const CHUNK = 18000;                   // the public LanguageTool endpoint accepts up to 20k characters per request

const wordsOf = (s) => s.match(/[A-Za-z0-9À-ɏ][A-Za-z0-9À-ɏ'’-]*/g) || [];

/* ---------- categories shown in the UI ---------- */
function categorize(m) {
  const id = String((m.rule && m.rule.id) || ""), cat = String((m.rule && m.rule.category && m.rule.category.id) || ""), issue = String((m.rule && m.rule.issueType) || "");
  if (/MORFOLOGIK|SPELL|HUNSPELL|SPELLING/i.test(id) || issue === "misspelling" || cat === "TYPOS") return "spelling";
  if (cat === "PUNCTUATION" || /COMMA|PUNCT|APOS|QUOTE|PERIOD|WHITESPACE|UPPERCASE_SENTENCE_START|SENTENCE_WHITESPACE/i.test(id)) return "punctuation";
  if (cat === "STYLE" || cat === "REDUNDANCY" || cat === "PLAIN_ENGLISH" || cat === "WIKIPEDIA" || issue === "style" || issue === "locale-violation") return "style";
  if (cat === "CASING" || cat === "COMPOUNDING" || cat === "SEMANTICS" || cat === "COLLOQUIALISMS" || cat === "REPETITIONS_STYLE") return "clarity";
  return "grammar";
}

/* ---------- LanguageTool ---------- */
async function languageTool(text, level) {
  const issues = [];
  const paras = [];                    // split on blank lines / lines so a chunk never cuts a word in half
  let cur = "", curStart = 0, pos = 0;
  const parts = text.split(/(\n)/);
  for (const p of parts) {
    if (cur.length + p.length > CHUNK && cur) { paras.push([cur, curStart]); cur = ""; curStart = pos; }
    cur += p; pos += p.length;
  }
  if (cur) paras.push([cur, curStart]);
  for (const [chunk, base] of paras) {
    if (!chunk.trim()) continue;
    const form = new URLSearchParams({ text: chunk, language: "en-US", enabledOnly: "false" });
    if (level === "picky") form.set("level", "picky");
    if (process.env.LANGUAGETOOL_USERNAME && process.env.LANGUAGETOOL_API_KEY) { form.set("username", process.env.LANGUAGETOOL_USERNAME); form.set("apiKey", process.env.LANGUAGETOOL_API_KEY); }
    const r = await fetch(LT_URL(), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" }, body: form, signal: AbortSignal.timeout(25000) });
    if (!r.ok) throw new Error("LanguageTool HTTP " + r.status);
    const j = await r.json();
    for (const m of j.matches || []) {
      issues.push({
        offset: base + m.offset, length: m.length,
        message: String(m.message || "").slice(0, 300), short: String(m.shortMessage || "").slice(0, 80),
        category: categorize(m), rule: String((m.rule && m.rule.id) || ""),
        replacements: (m.replacements || []).slice(0, 5).map((x) => String(x.value || "")).filter((v) => v.length <= 200)
      });
    }
  }
  return issues;
}

/* ---------- built-in fallback rules ---------- */
const MISSPELL = {
  teh: "the", recieve: "receive", recieved: "received", definately: "definitely", definatly: "definitely", seperate: "separate", seperately: "separately", occured: "occurred", occurence: "occurrence",
  untill: "until", wich: "which", becuase: "because", beacuse: "because", thier: "their", alot: "a lot", adress: "address", agressive: "aggressive", accomodate: "accommodate",
  acheive: "achieve", acknowlege: "acknowledge", aquire: "acquire", arguement: "argument", basicly: "basically", begining: "beginning", beleive: "believe", calender: "calendar",
  catagory: "category", collegue: "colleague", comming: "coming", commitee: "committee", completly: "completely", concious: "conscious", curiousity: "curiosity", decison: "decision",
  dependant: "dependent", desparate: "desperate", diffrent: "different", dissapear: "disappear", dissapoint: "disappoint", embarass: "embarrass", enviroment: "environment",
  existance: "existence", experiance: "experience", familar: "familiar", finaly: "finally", foriegn: "foreign", freind: "friend", fourty: "forty", goverment: "government",
  grammer: "grammar", gaurd: "guard", happend: "happened", harrass: "harass", heighth: "height", immediatly: "immediately", independant: "independent", intresting: "interesting",
  knowlege: "knowledge", liason: "liaison", libary: "library", lisence: "license", maintainance: "maintenance", millenium: "millennium", mispell: "misspell", neccessary: "necessary",
  necesary: "necessary", noticable: "noticeable", occassion: "occasion", occassionally: "occasionally", persistant: "persistent", posession: "possession", prefered: "preferred",
  privelege: "privilege", probly: "probably", publically: "publicly", realy: "really", reccomend: "recommend", recomend: "recommend", refered: "referred", relevent: "relevant",
  religous: "religious", remeber: "remember", resistence: "resistance", responsability: "responsibility", rythm: "rhythm", sargent: "sergeant", scedule: "schedule", sence: "sense",
  succesful: "successful", successfull: "successful", suprise: "surprise", tommorow: "tomorrow", tomorow: "tomorrow", truely: "truly", tyrany: "tyranny", unforseen: "unforeseen",
  unfortunatly: "unfortunately", wierd: "weird", whereever: "wherever", writting: "writing", yeild: "yield", paralel: "parallel", proffesor: "professor", sucess: "success",
  sumary: "summary", tecnology: "technology", thoughout: "throughout", usally: "usually", vaccum: "vacuum", visable: "visible", wether: "whether", wellcome: "welcome", writen: "written",
  alright: "all right", incase: "in case", infact: "in fact", eachother: "each other", aswell: "as well", cant: "can't", dont: "don't", wont: "won't", didnt: "didn't", doesnt: "doesn't",
  isnt: "isn't", wasnt: "wasn't", couldnt: "couldn't", shouldnt: "shouldn't", wouldnt: "wouldn't", im: "I'm", ive: "I've", youre: "you're"
};
const WORDY = [
  [/\bin order to\b/gi, "to"], [/\bdue to the fact that\b/gi, "because"], [/\bat this point in time\b/gi, "now"], [/\bin the event that\b/gi, "if"], [/\bfor the purpose of\b/gi, "for"],
  [/\bin spite of the fact that\b/gi, "although"], [/\bwith regard to\b/gi, "about"], [/\bit is important to note that\b/gi, ""], [/\ba large number of\b/gi, "many"],
  [/\bthe majority of\b/gi, "most"], [/\bin the near future\b/gi, "soon"], [/\bhas the ability to\b/gi, "can"], [/\bis able to\b/gi, "can"], [/\bon a daily basis\b/gi, "daily"],
  [/\bat the present time\b/gi, "currently"], [/\bin close proximity to\b/gi, "near"], [/\bprior to\b/gi, "before"], [/\bsubsequent to\b/gi, "after"], [/\bin addition to\b/gi, "besides"]
];
function basic(text) {
  const out = [], push = (offset, length, message, category, replacements, rule) => out.push({ offset, length, message, short: "", category, rule, replacements: replacements || [] });
  let m;
  const word = /[A-Za-z']+/g;
  while ((m = word.exec(text))) {
    const w = m[0], low = w.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MISSPELL, low)) {
      let fix = MISSPELL[low]; if (w[0] === w[0].toUpperCase() && fix[0] !== "I") fix = fix[0].toUpperCase() + fix.slice(1);
      push(m.index, w.length, /^[a-z]+nt$|^(im|ive|youre)$/.test(low) ? "Missing apostrophe." : "Possible spelling mistake.", "spelling", [fix], "BASIC_SPELL");
    }
    if (w === "i") push(m.index, 1, 'The pronoun "I" should be capitalised.', "grammar", ["I"], "BASIC_I");
  }
  const rep = /\b([A-Za-z']+)(\s+)\1\b/gi;
  while ((m = rep.exec(text))) if (!/^(that|had)$/i.test(m[1])) push(m.index, m[0].length, "Repeated word.", "grammar", [m[1]], "BASIC_REPEAT");
  const an = /\b(a|an)\s+([A-Za-z]+)/gi;
  while ((m = an.exec(text))) {
    const art = m[1], nxt = m[2].toLowerCase();
    const vowelSound = /^(hour|honest|honou?r|heir)/.test(nxt) || (/^[aeiou]/.test(nxt) && !/^(uni([^nm]|$)|use|usu|uti|eu|one|once|ubi)/.test(nxt));
    if (art.toLowerCase() === "a" && vowelSound) push(m.index, art.length, 'Use "an" before a vowel sound.', "grammar", [art === "A" ? "An" : "an"], "BASIC_AN");
    else if (art.toLowerCase() === "an" && !vowelSound) push(m.index, art.length, 'Use "a" before a consonant sound.', "grammar", [art === "An" ? "A" : "a"], "BASIC_A");
  }
  const sp = /[ \t]{2,}/g; while ((m = sp.exec(text))) push(m.index, m[0].length, "Extra spaces.", "punctuation", [" "], "BASIC_SPACES");
  const bp = /[ \t]+([,.;:!?])/g; while ((m = bp.exec(text))) push(m.index, m[0].length, "Remove the space before the punctuation mark.", "punctuation", [m[1]], "BASIC_SPACE_PUNCT");
  const ap = /([a-z]{2,})([,;:])([A-Za-z])/g; while ((m = ap.exec(text))) push(m.index, m[0].length, "Add a space after the punctuation mark.", "punctuation", [m[1] + m[2] + " " + m[3]], "BASIC_NOSPACE");
  const cap = /(^|[.!?]\s+|\n)([a-z])([a-z']*)/g;
  while ((m = cap.exec(text))) { const o = m.index + m[1].length, w = m[2] + m[3]; if (!/^(e\.g|i\.e|etc|vs)/.test(w)) push(o, w.length, "Capitalise the first word of a sentence.", "grammar", [m[2].toUpperCase() + m[3]], "BASIC_CAP"); }
  for (const [re, rep2] of WORDY) { re.lastIndex = 0; while ((m = re.exec(text))) push(m.index, m[0].length, rep2 ? `Wordy. Try "${rep2}".` : "Wordy. This phrase can be removed.", "style", [rep2], "BASIC_WORDY"); }
  const vint = /\b(very|really|extremely|quite|basically|actually|literally)\s+/gi;
  while ((m = vint.exec(text))) push(m.index, m[0].length, `"${m[1]}" is a weak intensifier. A stronger word is clearer.`, "style", [""], "BASIC_WEAK");
  // very long sentences
  const sre = /[^.!?\n]+[.!?]*/g;
  while ((m = sre.exec(text))) { const n = wordsOf(m[0]).length; if (n > 40) push(m.index + (m[0].length - m[0].trimStart().length), m[0].trim().length, `Long sentence (${n} words). Consider splitting it.`, "clarity", [], "BASIC_LONG"); }
  return out;
}

/* ---------- readability ---------- */
function syllables(w) {
  w = w.toLowerCase().replace(/[^a-z]/g, ""); if (!w) return 0; if (w.length <= 3) return 1;
  w = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const g = w.match(/[aeiouy]{1,2}/g); return Math.max(1, g ? g.length : 1);
}
function stats(text) {
  const w = wordsOf(text), sents = (text.match(/[^.!?\n]+[.!?]+|[^.!?\n]+$/g) || []).filter((s) => wordsOf(s).length > 0);
  const nw = w.length, ns = Math.max(1, sents.length), sy = w.reduce((a, x) => a + syllables(x), 0);
  const ease = nw ? 206.835 - 1.015 * (nw / ns) - 84.6 * (sy / nw) : 0;
  const grade = nw ? 0.39 * (nw / ns) + 11.8 * (sy / nw) - 15.59 : 0;
  const uniq = new Set(w.map((x) => x.toLowerCase())).size;
  return {
    words: nw, characters: text.length, sentences: sents.length, paragraphs: text.split(/\n{2,}/).filter((p) => p.trim()).length || 1,
    avgSentence: Math.round((nw / ns) * 10) / 10, readingEase: Math.max(0, Math.min(100, Math.round(ease))), gradeLevel: Math.max(0, Math.round(grade * 10) / 10),
    readingMinutes: Math.max(1, Math.round(nw / 230)), speakingMinutes: Math.max(1, Math.round(nw / 130)), vocabulary: nw ? Math.round((uniq / nw) * 100) : 0
  };
}
const easeLabel = (e) => e >= 80 ? "Easy to read" : e >= 60 ? "Plain English" : e >= 50 ? "Fairly difficult" : e >= 30 ? "Difficult" : "Very difficult";

/* ---------- main ---------- */
async function analyze(rawText, opts) {
  const text = String(rawText || "").replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").slice(0, MAX_CHARS);
  const st = stats(text);
  if (st.words < MIN_WORDS) throw Object.assign(new Error(`Please enter at least ${MIN_WORDS} words.`), { status: 400 });
  let issues, engine = "languagetool";
  try { issues = await languageTool(text, opts && opts.level); }
  catch (e) { console.warn("[GRAMMAR] LanguageTool unavailable, using built-in rules:", e.message); issues = basic(text); engine = "basic"; }

  // drop overlaps (keep the first / longest), clip to the text, give each a stable id
  issues = issues.filter((i) => i.offset >= 0 && i.length > 0 && i.offset + i.length <= text.length).sort((a, b) => a.offset - b.offset || b.length - a.length);
  const clean = []; let end = -1;
  for (const i of issues) { if (i.offset < end) continue; clean.push(i); end = i.offset + i.length; }
  clean.forEach((i, n) => { i.id = n + 1; i.original = text.slice(i.offset, i.offset + i.length); i.context = text.slice(Math.max(0, i.offset - 40), Math.min(text.length, i.offset + i.length + 40)).replace(/\s+/g, " "); });

  const counts = { grammar: 0, spelling: 0, punctuation: 0, style: 0, clarity: 0 };
  for (const i of clean) counts[i.category] = (counts[i.category] || 0) + 1;
  // score: 100 = clean; each issue costs more in short texts (weighted per 100 words)
  const weight = { spelling: 1.6, grammar: 1.6, punctuation: 1.0, clarity: 0.8, style: 0.5 };
  const pen = clean.reduce((a, i) => a + (weight[i.category] || 1), 0);
  const score = Math.max(0, Math.min(100, Math.round(100 - (pen / Math.max(40, st.words)) * 100 * 1.4)));
  return { engine, text, score, issues: clean, counts, total: clean.length, stats: { ...st, readingLabel: easeLabel(st.readingEase) } };
}

module.exports = { analyze, stats, MIN_WORDS, MAX_CHARS, _basic: basic };
