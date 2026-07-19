// Minimal argv parser used by every ported script.
//
// spec = {
//   name: "prog",
//   usage: "prog [options] <input>",
//   flags: {
//     out:      { short: "-o", takesValue: true, default: null },
//     clusters: { takesValue: true, type: "int" },
//     tag:      { takesValue: true, repeat: true },
//     verbose:  {},
//   },
// }
//
// parseArgs(spec, argv) -> { ...values, _: positionals }

function buildUsage(spec) {
  return spec.usage || `Usage: ${spec.name || "prog"}`;
}

function printUsage(spec, stream) {
  stream.write(buildUsage(spec) + "\n");
}

function toLong(name) {
  return `--${name}`;
}

export function die(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

export function parseArgs(spec, argv) {
  const flags = spec.flags || {};

  // Build lookup tables: "--name" and "-x" -> flag key
  const byFlagArg = new Map();
  for (const [key, def] of Object.entries(flags)) {
    byFlagArg.set(toLong(key), key);
    if (def.short) byFlagArg.set(def.short, key);
  }

  const values = {};
  for (const [key, def] of Object.entries(flags)) {
    if (def.repeat) {
      values[key] = [];
    } else if (Object.prototype.hasOwnProperty.call(def, "default")) {
      values[key] = def.default;
    } else if (def.takesValue) {
      values[key] = null;
    } else {
      values[key] = false;
    }
  }

  const positionals = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      printUsage(spec, process.stdout);
      process.exit(0);
    }

    if (arg.startsWith("-") && arg !== "-" && !/^-\d/.test(arg)) {
      // support --name=value
      let flagArg = arg;
      let inlineValue = null;
      const eq = arg.indexOf("=");
      if (arg.startsWith("--") && eq !== -1) {
        flagArg = arg.slice(0, eq);
        inlineValue = arg.slice(eq + 1);
      }

      const key = byFlagArg.get(flagArg);
      if (!key) {
        printUsage(spec, process.stderr);
        process.exit(2);
      }
      const def = flags[key];

      if (def.takesValue) {
        let raw;
        if (inlineValue !== null) {
          raw = inlineValue;
        } else {
          i++;
          if (i >= argv.length) {
            printUsage(spec, process.stderr);
            process.exit(2);
          }
          raw = argv[i];
        }
        let value = raw;
        if (def.type === "int") {
          value = parseInt(raw, 10);
          if (Number.isNaN(value)) {
            process.stderr.write(`error: invalid integer for ${flagArg}: ${raw}\n`);
            printUsage(spec, process.stderr);
            process.exit(2);
          }
        } else if (def.type === "float") {
          value = parseFloat(raw);
          if (Number.isNaN(value)) {
            process.stderr.write(`error: invalid number for ${flagArg}: ${raw}\n`);
            printUsage(spec, process.stderr);
            process.exit(2);
          }
        }
        if (def.repeat) {
          values[key].push(value);
        } else {
          values[key] = value;
        }
      } else {
        values[key] = true;
      }
      continue;
    }

    positionals.push(arg);
  }

  values._ = positionals;
  return values;
}
