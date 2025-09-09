import { Mastra } from "@mastra/core/mastra";
import { PinoLogger } from "@mastra/loggers";
import { weatherWorkflow } from "./workflows";
import { youtubeVSLWorkflow } from "./workflows/vsl-workflow";
import { weatherAgent } from "./agents";

export const mastra = new Mastra({
  workflows: { weatherWorkflow, youtubeVSLWorkflow },
  agents: { weatherAgent },
  logger: new PinoLogger({
    name: "Mastra",
    level: "info",
  }),
});
