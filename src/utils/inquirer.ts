import termSize from "term-size";
import inquirer from 'inquirer'
import enquirer from 'enquirer'
import colors from "ansi-colors";

// those types are not exported from `enquirer` so we extract them here
// so we can make type assertions using them because `enquirer` types do no support `prefix` right now
type PromptOptions = Extract<Parameters<typeof prompt>[0], { type: string }>;
type ArrayPromptOptions = Extract<
  PromptOptions,
  {
    type:
      | "autocomplete"
      | "editable"
      | "form"
      | "multiselect"
      | "select"
      | "survey"
      | "list"
      | "scale";
  }
>;
type BooleanPromptOptions = Extract<PromptOptions, { type: "confirm" }>;
type StringPromptOptions = Extract<
  PromptOptions,
  { type: "input" | "invisible" | "list" | "password" | "text" }
>;

/* Notes on using inquirer:
 * Each question needs a key, as inquirer is assembling an object behind-the-scenes.
 * At each call, the entire responses object is returned, so we need a unique
 * identifier for the name every time. This is why we are using serial IDs
 */
const serialId: () => number = (function () {
  let id = 0;
  return () => id++;
})();

const limit = Math.max(termSize().rows - 5, 10);

let cancelFlow = () => {
  console.log("Cancelled... 👋 ");
  process.exit();
};

export async function selectList(title: string, data: ({ name: string, value: number | string } | string)[]) {
  const { action } = await inquirer.prompt([
    {
      name: 'action',
      type: 'list',
      message: title,
      choices: data.map((item) => {
        if (typeof item === 'string') return { name: item, value: item }
        return item
      }),
    },
  ])

  return action
}

export const input = async (title: string) => {
  const { action } = await inquirer.prompt([
    {
      name: 'action',
      type: 'input',
      message: title,
    },
  ])

  return action
}

export const confirm = async (title: string, defaultValue?: boolean) => {
  const { action } = await inquirer.prompt([
    {
      name: 'action',
      type: 'confirm',
      message: title,
      default: defaultValue
    },
  ])

  return action
}

export const selectTree = async (
  message: string,
  choices: Array<any>,
  format?: (arg: any) => any
): Promise<string[]> => {
  const name = `CheckboxPlus-${serialId()}`;
  return enquirer.prompt({
    type: "autocomplete",
    name,
    message,
    // prefix,
    multiple: true,
    choices,
    format,
    limit,
    onCancel: cancelFlow,
    symbols: {
      indicator: colors.symbols.radioOff,
      checked: colors.symbols.radioOn,
    },
    indicator(state: any, choice: any) {
      return choice.enabled ? state.symbols.checked : state.symbols.indicator;
    },
  } as ArrayPromptOptions)
    .then((responses: any) => responses[name])
    .catch((err: unknown) => {
      console.log(err);
    });
}