import { parseArgs, die } from "../../../skills/drawio-skill/scripts/lib/args.mjs";

const spec = {
  name: "args-cli",
  usage: "Usage: args-cli [options] <input>",
  flags: {
    out: { short: "-o", takesValue: true, default: null },
    count: { takesValue: true, type: "int" },
    die: {},
  },
};

const opts = parseArgs(spec, process.argv.slice(2));
if (opts.die) die("something went wrong");
console.log(JSON.stringify(opts));
