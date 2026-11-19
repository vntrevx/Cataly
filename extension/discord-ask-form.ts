import { type AskData, type AskValue, type Field, parseAskFields } from "./discord-ask-fields.ts";
import { clean } from "./discord-ask-html.ts";

export type { AskData } from "./discord-ask-fields.ts";
export interface AskForm {
  readonly summary: string;
}
const privateForms = new WeakMap<AskForm, { fields: Field[]; hidden: AskData }>();
const FORM_LIMIT = 16_384,
  ANSWER_LIMIT = 2_000;
function display(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/`/g, "ˋ")
    .replace(/@/g, "@\u200b")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/[\\*_~|[\]]/g, "\\$&");
}
const show = (value: AskValue) =>
  `\`${JSON.stringify(value).replace(/[<@`\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (char) =>
    char
      .split("")
      .map((part) => `\\u${part.charCodeAt(0).toString(16).padStart(4, "0")}`)
      .join(""),
  )}\``;
function defaultValue(field: Field): AskValue | undefined {
  if (!field.options.length)
    return field.type === "number" && field.value.trim() && Number.isFinite(Number(field.value))
      ? Number(field.value)
      : field.value;
  const checked = field.options.filter((option) => option.checked && !option.disabled).map((option) => option.value);
  return field.multi && field.options.length > 1 ? checked : checked[0];
}
/** Conservatively project only forms whose complete prompt fits a Discord message. */
export async function projectAskForm(html: string): Promise<AskForm | undefined> {
  if (typeof html !== "string" || !html.trim() || html.length > FORM_LIMIT) return undefined;
  try {
    const { fields, hidden, context: visibleText } = await parseAskFields(html);
    const context = visibleText.split("\n").map(clean).filter(Boolean).map(display);
    const lines = fields.map((field) => {
      const flags = [field.type, field.required ? "required" : "optional", ...(field.disabled ? ["disabled"] : [])];
      for (const key of ["min", "max", "minLength", "maxLength"] as const)
        if (field[key] !== undefined) flags.push(`${key}=${field[key]}`);
      const choices = field.options
        .filter((option) => !option.disabled)
        .map((option) => `${show(option.value)} (${display(option.label)})`)
        .join(", ");
      const initial = defaultValue(field);
      return (
        `${show(field.name)}: ${display(field.label)} [${flags.join(", ")}${field.multi && field.options.length > 1 ? ", array" : ""}]` +
        (choices ? `; choices: ${choices}` : "") +
        (initial !== undefined ? `; default: ${show(initial)}` : "") +
        (field.other ? "; Other: include one custom text value" : "") +
        (field.placeholder ? `; hint: ${display(field.placeholder)}` : "") +
        (field.type === "checkbox" && field.options.length === 1 && !field.required ? "; [] clears" : "")
      );
    });
    const summary = [
      ...context,
      ...lines,
      "Reply with a JSON field map; omitted fields keep defaults. One editable field also accepts plain text.",
    ].join("\n");
    if (summary.length > 1_500) return undefined;
    const form: AskForm = Object.freeze({ summary });
    privateForms.set(form, { fields, hidden });
    return form;
  } catch {
    return undefined;
  }
}
/** Validate a reply against the exact projected form, retaining private hidden defaults. */
export function parseAskAnswer(form: AskForm, input: string): { data: AskData } | { error: string } {
  const model = privateForms.get(form);
  if (!model) return { error: "This form is no longer available." };
  if (typeof input !== "string" || input.length > ANSWER_LIMIT) return { error: "Answer is too long." };
  if (input.trim() === "") return { error: "Enter an answer or a JSON field map." };
  const editable = model.fields.filter(
    (field) => !field.disabled && (!field.options.length || field.options.some((option) => !option.disabled)),
  );
  let answer: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(input);
    if (value === null || Array.isArray(value) || typeof value !== "object") throw new Error();
    answer = value as Record<string, unknown>;
  } catch {
    if (/^\s*[[{]/.test(input)) return { error: "Enter a valid JSON field map." };
    if (editable.length !== 1) return { error: "Use a JSON field map for multiple fields." };
    const field = editable[0]!;
    answer = { [field.name]: field.multi && field.options.length > 1 ? [input] : input };
  }
  for (const key of Object.keys(answer)) {
    if (!editable.some((field) => field.name === key))
      return { error: `Unknown or disabled field: ${display(key.slice(0, 64))}.` };
  }
  const data: AskData = { ...model.hidden };
  for (const field of model.fields) {
    const supplied = Object.hasOwn(answer, field.name);
    let value: unknown = supplied ? answer[field.name] : defaultValue(field);
    const fail = (reason: string) => ({ error: `${display(field.name)}: ${reason}` });
    if (field.options.length) {
      const array = field.multi && field.options.length > 1;
      if (!array && field.type === "checkbox" && Array.isArray(value) && !value.length) value = undefined;
      if (
        array
          ? !Array.isArray(value) || value.some((item) => typeof item !== "string")
          : value !== undefined && typeof value !== "string"
      )
        return fail(array ? "Enter an array of choice values." : "Enter one choice value.");
      const values: string[] = value === undefined ? [] : Array.isArray(value) ? value : [value as string];
      if (new Set(values).size !== values.length) return fail("Choose only enabled values shown in the form.");
      const selected = new Set<string>();
      let other: string | undefined;
      for (const item of values) {
        const option = field.options.find((option) => option.value === item);
        if (option && !option.disabled) selected.add(item);
        else if (!option && field.other && other === undefined) other = item.trim();
        else return fail("Choose only enabled values shown in the form.");
      }
      const ordered = field.options.filter((option) => selected.has(option.value)).map((option) => option.value);
      if (other) ordered.push(other);
      if (field.required && !ordered.length) return fail(array ? "Select at least one." : "Required.");
      value = array ? ordered : ordered[0];
    } else {
      if (typeof value !== "string" && !(field.type === "number" && typeof value === "number"))
        return fail(field.type === "number" ? "Enter a number." : "Enter text.");
      let string = String(value);
      if (!string.trim()) {
        if (field.required) return fail("Required.");
      } else {
        if (field.type === "number") {
          const number = Number(value);
          if (!Number.isFinite(number)) return fail("Enter a number.");
          if (field.min !== undefined && number < field.min) return fail(`Must be at least ${field.min}.`);
          if (field.max !== undefined && number > field.max) return fail(`Must be at most ${field.max}.`);
          value = number;
          string = String(number);
        }
        if (field.minLength !== undefined && string.length < field.minLength)
          return fail(`Needs at least ${field.minLength} characters.`);
        if (field.maxLength !== undefined && string.length > field.maxLength)
          return fail(`At most ${field.maxLength} characters.`);
      }
    }
    if (value !== undefined) data[field.name] = value as AskValue;
  }
  return { data };
}
