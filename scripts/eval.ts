import "dotenv/config";
import {compose} from "../src/recovery/composer.ts";
import { CASES } from "../src/eval/cases.ts";
import * as fs from "fs/promises";

const apiKey = process.env.GROQ_API_KEY;
if (!apiKey) {
  console.error("GROQ_API_KEY is not set — nothing to benchmark.");
  process.exit(1);
}
interface EvalResult {
  id: string;
  /** Recorded because the judge has to know what the composer was given. */
  name?: string | null;
  method: string;
  source: string;
  rejectionReason: string | undefined;
  template: string;
  text: string;
}

const results: EvalResult[] = [];

for (const c of CASES) {
  const output = await compose(c.failureClass, c.context, c.options);
  
  results.push({
    id: c.id,
    name: c.context.name,
    method: c.context.method,
    source: output.source,
    rejectionReason: output.rejectionReason,
    template: output.template,
    text: output.text,
  });
}
await fs.writeFile(
  "eval_results.json", 
  JSON.stringify(results, null, 2), 
  "utf-8"
);