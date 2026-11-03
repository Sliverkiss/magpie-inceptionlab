// Tool preamble (manifest) builder. Port of app/internal/tools/manifest.go.
//
// The preamble wording is protocol, not copy: with definitions as plain JSON
// lines the upstream answers, but a "<tools>…</tools>" catalogue block
// produced no text in 10/10 live probes. Do not reword without a new probe
// matrix.

// PreStyle selects the preamble skeleton: "hermes" (measured 7/8 hit rate) or
// "inception" (reconstructed AI-SDK v5 style the upstream chat itself runs
// under).
export const PRE_STYLE = 'hermes';

const HERMES_SKELETON = {
  lead: 'You are a helpful assistant with access to the following tools:',
  contract:
    '\nIf you need to use a tool, respond with a <tool_call> JSON block ' +
    'containing {"name": "tool name", "arguments": {…}}. ' +
    'Use only the tools listed; never invent one. Otherwise answer normally.',
};

const INCEPTION_SKELETON = {
  lead:
    '# Tool Operations\n\n' +
    '1. Instruction Following: Prioritize using a listed operation whenever the user\'s request needs one, before answering in prose.' +
    ' Accuracy & Detail: use only the operations listed below; their argument schemas are the source of truth.' +
    ' Safety & Ethics: never invent an operation that is not listed.' +
    ' Code outputs: when you call an operation, the first characters of your reply must be the marker <tool_call>' +
    ' followed by one JSON block containing {"name": "tool name", "arguments": {…}}, closed by </tool_call>' +
    ' — never write the block as plain text.' +
    ' Conversational Momentum: otherwise answer normally in prose.',
  contract:
    '\nEvery operation call uses the <tool_call>...</tool_call> marker block; a bare JSON object without the marker is invalid.',
};

// Anti-stall rule appended to every preamble style.
const CONTINUATION_RULE =
  'After a tool result arrives, if the task is not yet complete, immediately call the next tool. Never end your turn with only a description of what you are about to do.';

// BuildManifest renders the tool preamble. choice is {auto, required, named};
// parallelOff adds the "at most one per turn" instruction. Throws only for a
// tool with a blank name or an empty selection (the request decoder rejects
// those with a 400 before this point; the check keeps this module safe to
// call on its own).
export function buildManifest(list, choice, parallelOff) {
  let selected = list;
  if (choice.named) {
    selected = list.filter((t) => t.name === choice.named);
    if (selected.length === 0) {
      // The caller asked for a tool it did not declare. Honour the
      // instruction with a name-only entry so the model can still emit the
      // requested call.
      selected = [{ name: choice.named, description: '', parameters: {} }];
    }
  }
  if (selected.length === 0) throw new Error('tools: manifest needs at least one tool');
  for (const t of selected) {
    if (!String(t.name ?? '').trim()) throw new Error('tools: tool name must not be empty');
  }

  let instructions = '';
  if (choice.named) {
    instructions += `\nYou must use the operation ${JSON.stringify(choice.named)}. Do not use any other operation.\n`;
  } else if (choice.required) {
    instructions += '\nYou MUST use at least one operation before answering.\n';
  }
  if (parallelOff) instructions += '\nUse at most one operation per turn.\n';

  const sk = PRE_STYLE === 'inception' ? INCEPTION_SKELETON : HERMES_SKELETON;
  let defs = '';
  for (const t of selected) {
    // An empty description renders as an omitted field, not literal "".
    const desc = t.description ? `,"description":${JSON.stringify(t.description)}` : '';
    defs += `{"name":${JSON.stringify(t.name)}${desc},"parameters":${compactParams(t.parameters)}}\n`;
  }
  let preamble = sk.lead + '\n\n' + defs + sk.contract + '\n';
  const ex = workedExample(selected);
  if (ex) preamble += ex + '\n';
  preamble += CONTINUATION_RULE + '\n';
  preamble += instructions;

  return { preamble, declared: selected.map((t) => t.name) };
}

// workedExample renders concrete marker-block examples from up to TWO
// declared tools' real names and minimal argument shapes derived from their
// parameter schemas.
function workedExample(list) {
  const lines = [];
  const seen = new Set();
  for (const t of list) {
    if (!String(t.name ?? '').trim() || seen.has(t.name)) continue;
    seen.add(t.name);
    lines.push(
      `Example: <tool_call>{"name":${JSON.stringify(t.name)},"arguments":${exampleArguments(t.parameters)}}</tool_call>`,
    );
    if (seen.size === 2) break;
  }
  return lines.join('\n');
}

// exampleArguments derives a minimal argument object from a JSON schema:
// required properties only when listed, else every property in schema order.
// Type mapping: string -> "...", integer/number -> 1, boolean -> true,
// object -> {}, array -> [], anything else -> "...".
function exampleArguments(raw) {
  if (raw === undefined || raw === null) return '{}';
  let schema;
  try {
    schema = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return '{}';
  }
  if (typeof schema !== 'object' || schema === null) return '{}';
  const names = Object.keys(schema.properties ?? {});
  if (names.length === 0) return '{}';
  let required = Array.isArray(schema.required) ? schema.required : [];
  if (required.length === 0) required = names;
  const parts = [];
  for (const name of required) {
    const prop = schema.properties?.[name];
    if (prop === undefined) continue;
    parts.push(`${JSON.stringify(name)}:${exampleValue(prop)}`);
  }
  return '{' + parts.join(',') + '}';
}

// exampleValue maps a schema "type" value — single name, array of names, or
// absent — to the minimal example placeholder. Array types pick the concrete
// type by precedence array > object > boolean > integer/number > string.
function exampleValue(prop) {
  let type = prop?.type;
  if (type === undefined || type === null) return '"..."';
  const names = Array.isArray(type) ? type : [type];
  if (names.length === 0) return '"..."';
  const set = new Set(names.filter((n) => n !== 'null'));
  for (const preferred of ['array', 'object', 'boolean', 'integer', 'number', 'string']) {
    if (set.has(preferred)) return exampleForName(preferred);
  }
  return '"..."'; // a concrete type we do not model, or all-null
}

function exampleForName(name) {
  switch (name) {
    case 'string': return '"..."';
    case 'integer':
    case 'number': return '1';
    case 'boolean': return 'true';
    case 'object': return '{}';
    case 'array': return '[]';
    default: return '"..."';
  }
}

// compactParams renders a parameter schema compactly, or {} when absent or
// not valid JSON.
function compactParams(raw) {
  if (raw === undefined || raw === null) return '{}';
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return JSON.stringify(v ?? {});
  } catch {
    return '{}';
  }
}
