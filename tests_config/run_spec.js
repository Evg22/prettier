"use strict";

const fs = require("fs");
const extname = require("path").extname;
const prettier = require("../");
const parser = require("../src/parser");
const massageAST = require("../src/clean-ast.js").massageAST;

const AST_COMPARE = process.env["AST_COMPARE"];
const VERIFY_ALL_PARSERS = process.env["VERIFY_ALL_PARSERS"] || false;
const ALL_PARSERS = process.env["ALL_PARSERS"]
  ? JSON.parse(process.env["ALL_PARSERS"])
  : ["flow", "babylon", "typescript"];

function run_spec(dirname, options, additionalParsers) {
  fs.readdirSync(dirname).forEach(filename => {
    const extension = extname(filename);
    if (/^\.[jt]sx?$/.test(extension) && filename !== "jsfmt.spec.js") {
      const path = dirname + "/" + filename;
      let rangeStart = 0;
      let rangeEnd = Infinity;
      const source = read(path)
        .replace(/\r\n/g, "\n")
        .replace("<<<PRETTIER_RANGE_START>>>", (match, offset) => {
          rangeStart = offset;
          return "";
        })
        .replace("<<<PRETTIER_RANGE_END>>>", (match, offset) => {
          rangeEnd = offset;
          return "";
        });

      const mergedOptions = Object.assign(mergeDefaultOptions(options || {}), {
        rangeStart: rangeStart,
        rangeEnd: rangeEnd
      });
      const output = prettyprint(source, path, mergedOptions);
      test(`${mergedOptions.parser} - ${parser.parser}-verify`, () => {
        expect(raw(source + "~".repeat(80) + "\n" + output)).toMatchSnapshot(
          filename
        );
      });

      getParsersToVerify(
        mergedOptions.parser,
        additionalParsers || []
      ).forEach(parserName => {
        test(`${filename} - ${parserName}-verify`, () => {
          const verifyOptions = Object.assign(mergedOptions, {
            parser: parserName
          });
          const verifyOutput = prettyprint(source, path, verifyOptions);
          expect(output).toEqual(verifyOutput);
        });
      });

      if (AST_COMPARE) {
        const ast = parse(source, mergedOptions);
        const astMassaged = massageAST(ast);
        let ppastMassaged;
        let pperr = null;
        try {
          const ppast = parse(
            prettyprint(source, path, mergedOptions),
            mergedOptions
          );
          ppastMassaged = massageAST(ppast);
        } catch (e) {
          pperr = e.stack;
        }

        test(path + " parse", () => {
          expect(pperr).toBe(null);
          expect(ppastMassaged).toBeDefined();
          if (!ast.errors || ast.errors.length === 0) {
            expect(astMassaged).toEqual(ppastMassaged);
          }
        });
      }
    }
  });
}
global.run_spec = run_spec;

function stripLocation(ast) {
  if (Array.isArray(ast)) {
    return ast.map(e => stripLocation(e));
  }
  if (typeof ast === "object") {
    const newObj = {};
    for (const key in ast) {
      if (
        key === "loc" ||
        key === "range" ||
        key === "raw" ||
        key === "comments"
      ) {
        continue;
      }
      newObj[key] = stripLocation(ast[key]);
    }
    return newObj;
  }
  return ast;
}

function parse(string, opts) {
  return stripLocation(parser.parse(string, opts));
}

function prettyprint(src, filename, options) {
  return prettier.format(
    src,
    Object.assign(
      {
        filename
      },
      options
    )
  );
}

function read(filename) {
  return fs.readFileSync(filename, "utf8");
}

/**
 * Wraps a string in a marker object that is used by `./raw-serializer.js` to
 * directly print that string in a snapshot without escaping all double quotes.
 * Backticks will still be escaped.
 */
function raw(string) {
  if (typeof string !== "string") {
    throw new Error("Raw snapshots have to be strings.");
  }
  return { [Symbol.for("raw")]: string };
}

function mergeDefaultOptions(parserConfig) {
  return Object.assign(
    {
      parser: "flow",
      printWidth: 80
    },
    parserConfig
  );
}

function getParsersToVerify(parser, additionalParsers) {
  if (VERIFY_ALL_PARSERS) {
    return ALL_PARSERS.splice(ALL_PARSERS.indexOf(parser), 1);
  }
  return additionalParsers;
}
