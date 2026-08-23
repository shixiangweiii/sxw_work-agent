/**
 * 两个纯只读、无副作用、返回固定假数据的工具。
 *
 * 选这两个是为了让「同时问北京和上海的天气和时间」这一句 prompt
 * 必然需要 4 次调用，从而稳定触发并行 tool call（P1）。
 */

export const WEATHER_TOOL_NAME = "get_weather";
export const TIME_TOOL_NAME = "get_time";

const weatherSchema = {
  type: "object",
  properties: {
    city: { type: "string", description: "城市名，例如 北京" },
  },
  required: ["city"],
  additionalProperties: false,
} as const;

const timeSchema = {
  type: "object",
  properties: {
    city: { type: "string", description: "城市名，例如 上海" },
  },
  required: ["city"],
  additionalProperties: false,
} as const;

/** Anthropic Messages API 的工具定义形状 */
export const anthropicTools = [
  {
    name: WEATHER_TOOL_NAME,
    description: "查询某个城市的当前天气。只读，无副作用。",
    input_schema: weatherSchema,
  },
  {
    name: TIME_TOOL_NAME,
    description: "查询某个城市的当前时间。只读，无副作用。",
    input_schema: timeSchema,
  },
];

/** OpenAI Chat Completions 的工具定义形状 */
export const openaiChatTools = [
  {
    type: "function",
    function: {
      name: WEATHER_TOOL_NAME,
      description: "查询某个城市的当前天气。只读，无副作用。",
      parameters: weatherSchema,
    },
  },
  {
    type: "function",
    function: {
      name: TIME_TOOL_NAME,
      description: "查询某个城市的当前时间。只读，无副作用。",
      parameters: timeSchema,
    },
  },
];

/** OpenAI Responses API 的工具定义形状（扁平，无 function 包装） */
export const openaiResponsesTools = [
  {
    type: "function",
    name: WEATHER_TOOL_NAME,
    description: "查询某个城市的当前天气。只读，无副作用。",
    parameters: weatherSchema,
  },
  {
    type: "function",
    name: TIME_TOOL_NAME,
    description: "查询某个城市的当前时间。只读，无副作用。",
    parameters: timeSchema,
  },
];

/** 固定假数据。真实性无关紧要，稳定性才重要 —— 便于跨次运行对比。 */
export function fakeToolResult(toolName: string, input: any): string {
  const city = input?.city ?? "未知";
  if (toolName === WEATHER_TOOL_NAME) {
    return JSON.stringify({ city, condition: "晴", temperatureC: 26, humidity: 0.41 });
  }
  if (toolName === TIME_TOOL_NAME) {
    return JSON.stringify({ city, localTime: "2026-08-22T14:30:00+08:00", timezone: "Asia/Shanghai" });
  }
  return JSON.stringify({ error: "unknown tool", toolName });
}

/**
 * 这句 prompt 需要 2 城市 × 2 工具 = 4 次调用。
 * 明确要求「一次性全部查完」是为了最大化触发并行的概率。
 */
export const PARALLEL_PROMPT =
  "我要同时了解北京和上海的情况。请一次性把这两个城市的天气和当前时间都查出来，然后一起告诉我。";

export const SYSTEM_PROMPT =
  "你是一个协议测试助手。当需要外部数据时，直接调用工具，不要询问用户。";
