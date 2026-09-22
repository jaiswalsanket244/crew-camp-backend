import { FIELD_TYPE } from "../enums/checklist";
import {
  FieldConfigType,
  FieldDefinitionType,
  FieldResponseType,
  FieldResponseValue,
  SelectOptionType,
} from "../interfaces/schemaInterface";

/**
 * Server-side mirror of web `src/utils/checklistProgress.ts` and mobile
 * `src/util/helpers/checklistProgress.ts`. The three implementations must stay
 * in lockstep. This is the source of truth for typed-field validation and
 * task-completion semantics.
 */

const LABEL_MAX = 500;
const TEXT_MAX = 10000;
const OPTION_TEXT_MAX = 200;
const UNIT_MAX = 20;
const OPTIONS_MIN = 1;
const OPTIONS_MAX = 100;
const RATING_ALLOWED = [3, 4, 5, 7, 10];
const DEFAULT_MAX_RATING = 5;

const EPSILON = 1e-9;

const isPlainObject = (val: unknown): val is Record<string, unknown> =>
  typeof val === "object" && val !== null && !Array.isArray(val);

const isFiniteNumber = (val: unknown): val is number =>
  typeof val === "number" && Number.isFinite(val);

const isInteger = (val: unknown): val is number =>
  typeof val === "number" && Number.isInteger(val);

const isString = (val: unknown): val is string => typeof val === "string";

// Which config keys are meaningful per field type; everything else is stripped.
const ALLOWED_CONFIG_KEYS: Record<string, string[]> = {
  [FIELD_TYPE.CHECKBOX]: [],
  [FIELD_TYPE.DATE]: [],
  [FIELD_TYPE.TEXT]: ["placeholder", "multiline"],
  [FIELD_TYPE.YES_NO]: ["allowNA"],
  [FIELD_TYPE.RATING]: ["maxRating"],
  [FIELD_TYPE.SELECT]: ["options"],
  [FIELD_TYPE.MULTI_SELECT]: ["options", "minSelections", "maxSelections"],
  [FIELD_TYPE.NUMBER]: ["unit", "min", "max", "decimalPlaces"],
};

/**
 * Return a shallow copy of `config` containing only the keys meaningful for the
 * given field type (Mixed schema field — do not persist client garbage).
 */
export const stripConfig = (
  fieldType: FIELD_TYPE,
  config: FieldConfigType | undefined,
): FieldConfigType => {
  const allowed = ALLOWED_CONFIG_KEYS[fieldType] || [];
  const source = isPlainObject(config) ? config : {};
  const cleaned: FieldConfigType = {};
  for (const key of allowed) {
    if (source[key] !== undefined) {
      cleaned[key] = source[key];
    }
  }
  return cleaned;
};

const validateOptions = (options: unknown): string | null => {
  if (!Array.isArray(options)) return "options must be an array";
  if (options.length < OPTIONS_MIN) return "add at least one option";
  if (options.length > OPTIONS_MAX)
    return `options must have at most ${OPTIONS_MAX} entries`;

  const seen = new Set<string>();
  for (const opt of options as SelectOptionType[]) {
    if (!isPlainObject(opt)) return "each option must be an object";
    if (!isString(opt.label) || opt.label.trim() === "")
      return "option label is required";
    if (!isString(opt.value) || opt.value.trim() === "")
      return "option value is required";
    if (opt.label.length > OPTION_TEXT_MAX)
      return `option label must be at most ${OPTION_TEXT_MAX} chars`;
    if (opt.value.length > OPTION_TEXT_MAX)
      return `option value must be at most ${OPTION_TEXT_MAX} chars`;
    const key = opt.value.toLowerCase();
    if (seen.has(key)) return "option values must be unique";
    seen.add(key);
  }
  return null;
};

/**
 * Validate a field definition's structure. Returns an error message string, or
 * `null` when valid.
 */
export const validateFieldDefinition = (
  field: FieldDefinitionType,
): string | null => {
  if (!isPlainObject(field)) return "field must be an object";

  // fieldType
  const validTypes = Object.values(FIELD_TYPE) as string[];
  if (!isString(field.fieldType) || !validTypes.includes(field.fieldType))
    return "invalid fieldType";
  if (field.fieldType === FIELD_TYPE.PHOTO)
    return "photo fields are not supported";

  // label
  if (!isString(field.label) || field.label.trim() === "")
    return "label is required";
  if (field.label.length > LABEL_MAX)
    return `label must be at most ${LABEL_MAX} chars`;

  // required
  if (field.required !== undefined && typeof field.required !== "boolean")
    return "required must be a boolean";

  // sortOrder
  if (field.sortOrder !== undefined) {
    if (!isFiniteNumber(field.sortOrder) || field.sortOrder < 0)
      return "sortOrder must be a number >= 0";
  }

  const config: FieldConfigType = isPlainObject(field.config)
    ? field.config
    : {};

  switch (field.fieldType) {
    case FIELD_TYPE.CHECKBOX:
    case FIELD_TYPE.DATE:
      // config must be empty of meaningful keys — unknown keys are stripped on
      // persist, so nothing to validate here.
      return null;

    case FIELD_TYPE.TEXT: {
      if (config.placeholder !== undefined) {
        if (!isString(config.placeholder))
          return "placeholder must be a string";
        if (config.placeholder.length > LABEL_MAX)
          return `placeholder must be at most ${LABEL_MAX} chars`;
      }
      if (
        config.multiline !== undefined &&
        typeof config.multiline !== "boolean"
      )
        return "multiline must be a boolean";
      return null;
    }

    case FIELD_TYPE.YES_NO: {
      if (config.allowNA !== undefined && typeof config.allowNA !== "boolean")
        return "allowNA must be a boolean";
      return null;
    }

    case FIELD_TYPE.RATING: {
      if (config.maxRating !== undefined) {
        if (
          !isInteger(config.maxRating) ||
          !RATING_ALLOWED.includes(config.maxRating)
        )
          return "maxRating must be one of 3, 4, 5, 7, 10";
      }
      return null;
    }

    case FIELD_TYPE.SELECT: {
      const optErr = validateOptions(config.options);
      if (optErr) return optErr;
      return null;
    }

    case FIELD_TYPE.MULTI_SELECT: {
      const optErr = validateOptions(config.options);
      if (optErr) return optErr;
      const optionCount = (config.options as SelectOptionType[]).length;
      if (config.minSelections !== undefined) {
        if (!isInteger(config.minSelections) || config.minSelections < 0)
          return "minSelections must be an integer >= 0";
      }
      if (config.maxSelections !== undefined) {
        if (!isInteger(config.maxSelections) || config.maxSelections < 0)
          return "maxSelections must be an integer >= 0";
      }
      const min = config.minSelections;
      const max = config.maxSelections;
      if (min !== undefined && max !== undefined && min > max)
        return "minSelections must be <= maxSelections";
      if (max !== undefined && max > optionCount)
        return "maxSelections must be <= number of options";
      if (min !== undefined && min > optionCount)
        return "minSelections must be <= number of options";
      return null;
    }

    case FIELD_TYPE.NUMBER: {
      if (config.unit !== undefined) {
        if (!isString(config.unit)) return "unit must be a string";
        if (config.unit.length > UNIT_MAX)
          return `unit must be at most ${UNIT_MAX} chars`;
      }
      if (config.min !== undefined && !isFiniteNumber(config.min))
        return "min must be a finite number";
      if (config.max !== undefined && !isFiniteNumber(config.max))
        return "max must be a finite number";
      if (
        config.min !== undefined &&
        config.max !== undefined &&
        config.min > config.max
      )
        return "min must be less than max";
      if (config.decimalPlaces !== undefined) {
        if (
          !isInteger(config.decimalPlaces) ||
          config.decimalPlaces < 0 ||
          config.decimalPlaces > 3
        )
          return "decimalPlaces must be an integer between 0 and 3";
      }
      return null;
    }

    default:
      return "invalid fieldType";
  }
};

const isRealCalendarDate = (val: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(val)) return false;
  const [y, m, d] = val.split("-").map((p) => parseInt(p, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
};

/**
 * Validate a response value against its field definition. Returns an error
 * message string, or `null` when valid. `null` value is always valid (= clear).
 */
export const validateResponseValue = (
  field: FieldDefinitionType,
  value: FieldResponseValue,
): string | null => {
  if (value === null) return null;

  const config: FieldConfigType = isPlainObject(field.config)
    ? field.config
    : {};

  switch (field.fieldType) {
    case FIELD_TYPE.CHECKBOX:
      if (typeof value !== "boolean") return "value must be a boolean";
      return null;

    case FIELD_TYPE.TEXT:
      if (!isString(value)) return "value must be a string";
      if (value.length > TEXT_MAX)
        return `value must be at most ${TEXT_MAX} chars`;
      return null;

    case FIELD_TYPE.YES_NO: {
      if (!isString(value)) return "value must be a string";
      if (value === "yes" || value === "no") return null;
      if (value === "na" && config.allowNA === true) return null;
      return 'value must be "yes", "no"' + (config.allowNA ? ' or "na"' : "");
    }

    case FIELD_TYPE.RATING: {
      const maxRating = isInteger(config.maxRating)
        ? config.maxRating
        : DEFAULT_MAX_RATING;
      if (!isInteger(value)) return "value must be an integer";
      if (value < 1 || value > maxRating)
        return `value must be between 1 and ${maxRating}`;
      return null;
    }

    case FIELD_TYPE.SELECT: {
      if (!isString(value)) return "value must be a string";
      const options = Array.isArray(config.options) ? config.options : [];
      const isValid = options.some((o) => o.value === value);
      if (!isValid) return "value must be one of the configured options";
      return null;
    }

    case FIELD_TYPE.MULTI_SELECT: {
      if (!Array.isArray(value)) return "value must be an array";
      if (!value.every((v) => isString(v)))
        return "value must be an array of strings";
      const unique = new Set(value as string[]);
      if (unique.size !== value.length)
        return "value must not contain duplicates";
      const options = Array.isArray(config.options) ? config.options : [];
      const validValues = new Set(options.map((o) => o.value));
      for (const v of value as string[]) {
        if (!validValues.has(v))
          return "value must contain only configured options";
      }
      // Empty array = cleared; min is enforced only when non-empty.
      if (value.length > 0) {
        if (
          isInteger(config.minSelections) &&
          value.length < config.minSelections
        )
          return `select at least ${config.minSelections} options`;
      }
      if (
        isInteger(config.maxSelections) &&
        value.length > config.maxSelections
      )
        return `select at most ${config.maxSelections} options`;
      return null;
    }

    case FIELD_TYPE.NUMBER: {
      if (!isFiniteNumber(value)) return "value must be a number";
      if (isFiniteNumber(config.min) && value < config.min)
        return `value must be >= ${config.min}`;
      if (isFiniteNumber(config.max) && value > config.max)
        return `value must be <= ${config.max}`;
      const dp = isInteger(config.decimalPlaces) ? config.decimalPlaces : 0;
      const factor = Math.pow(10, dp);
      if (Math.abs(Math.round(value * factor) - value * factor) > EPSILON)
        return `value must have at most ${dp} decimal places`;
      return null;
    }

    case FIELD_TYPE.DATE: {
      if (!isString(value)) return "value must be a string";
      if (!isRealCalendarDate(value))
        return "value must be a valid YYYY-MM-DD date";
      return null;
    }

    default:
      return "invalid fieldType";
  }
};

/**
 * Whether a single field currently has a meaningful answer.
 */
export const isFieldAnswered = (
  field: FieldDefinitionType,
  response: FieldResponseType | undefined | null,
): boolean => {
  if (!response) return false;
  const value = response.value;

  switch (field.fieldType) {
    case FIELD_TYPE.CHECKBOX:
      return value === true;
    case FIELD_TYPE.TEXT:
      return isString(value) && value.trim() !== "";
    case FIELD_TYPE.MULTI_SELECT:
      return Array.isArray(value) && value.length > 0;
    default:
      return value !== null && value !== undefined && value !== "";
  }
};

interface TaskCompletableTodo {
  fields?: FieldDefinitionType[];
  responses?: FieldResponseType[];
  areImagesMandatory?: boolean;
  images?: unknown[];
  postId?: unknown;
}

/**
 * Server-authoritative task completion for typed-field todos. Every required
 * field must be answered AND, when `areImagesMandatory`, a completion post/image
 * must be present. This is not consulted for field-less todos on the manual path.
 */
export const isTaskComplete = (todo: TaskCompletableTodo): boolean => {
  const fields = Array.isArray(todo.fields) ? todo.fields : [];
  const responses = Array.isArray(todo.responses) ? todo.responses : [];

  const responseByField = new Map<string, FieldResponseType>();
  for (const r of responses) {
    responseByField.set(String(r.fieldId), r);
  }

  for (const field of fields) {
    if (field.required === true) {
      const response = responseByField.get(String(field._id));
      if (!isFieldAnswered(field, response)) return false;
    }
  }

  if (todo.areImagesMandatory) {
    const hasImages = Array.isArray(todo.images) && todo.images.length > 0;
    const hasPost = !!todo.postId;
    if (!hasImages && !hasPost) return false;
  }

  return true;
};

/**
 * Count answered required/all fields for a single todo.
 */
export const countTodoFields = (
  todo: TaskCompletableTodo,
): { totalFields: number; completedFields: number } => {
  const fields = Array.isArray(todo.fields) ? todo.fields : [];
  const responses = Array.isArray(todo.responses) ? todo.responses : [];

  const responseByField = new Map<string, FieldResponseType>();
  for (const r of responses) {
    responseByField.set(String(r.fieldId), r);
  }

  let completedFields = 0;
  for (const field of fields) {
    const response = responseByField.get(String(field._id));
    if (isFieldAnswered(field, response)) completedFields += 1;
  }

  return { totalFields: fields.length, completedFields };
};
