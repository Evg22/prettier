"use strict";

const comments = require("./src/comments");
const version = require("./package.json").version;
const printAstToDoc = require("./src/printer").printAstToDoc;
const util = require("./src/util");
const printDocToString = require("./src/doc-printer").printDocToString;
const normalizeOptions = require("./src/options").normalize;
const parser = require("./src/parser");
const printDocToDebug = require("./src/doc-debug").printDocToDebug;

function guessLineEnding(text) {
  const index = text.indexOf("\n");
  if (index >= 0 && text.charAt(index - 1) === "\r") {
    return "\r\n";
  }
  return "\n";
}

function attachComments(text, ast, opts) {
  const astComments = ast.comments;
  if (astComments) {
    delete ast.comments;
    comments.attach(astComments, ast, text, opts);
  }
  ast.tokens = [];
  opts.originalText = text.trimRight();
  return astComments;
}

function ensureAllCommentsPrinted(astComments) {
  for (let i = 0; i < astComments.length; ++i) {
    if (astComments[i].value.trim() === "prettier-ignore") {
      // If there's a prettier-ignore, we're not printing that sub-tree so we
      // don't know if the comments was printed or not.
      return;
    }
  }

  astComments.forEach(comment => {
    if (!comment.printed) {
      throw new Error(
        'Comment "' +
          comment.value.trim() +
          '" was not printed. Please report this error!'
      );
    }
    delete comment.printed;
  });
}

function format(text, opts, addAlignmentSize) {
  addAlignmentSize = addAlignmentSize || 0;

  const ast = parser.parse(text, opts);

  const formattedRangeOnly = formatRange(text, opts, ast);
  if (formattedRangeOnly) {
    return formattedRangeOnly;
  }

  const astComments = attachComments(text, ast, opts);
  const doc = printAstToDoc(ast, opts, addAlignmentSize);
  opts.newLine = guessLineEnding(text);
  const str = printDocToString(doc, opts);
  ensureAllCommentsPrinted(astComments);
  // Remove extra leading indentation as well as the added indentation after last newline
  if (addAlignmentSize > 0) {
    return str.trim() + opts.newLine;
  }
  return str;
}

function findSiblingAncestors(startNodeAndParents, endNodeAndParents) {
  let resultStartNode = startNodeAndParents.node;
  let resultEndNode = endNodeAndParents.node;

  for (const endParent of endNodeAndParents.parentNodes) {
    if (util.locStart(endParent) >= util.locStart(startNodeAndParents.node)) {
      resultEndNode = endParent;
    } else {
      break;
    }
  }

  for (const startParent of startNodeAndParents.parentNodes) {
    if (util.locEnd(startParent) <= util.locEnd(endNodeAndParents.node)) {
      resultStartNode = startParent;
    } else {
      break;
    }
  }

  return {
    startNode: resultStartNode,
    endNode: resultEndNode
  };
}

function findNodeAtOffset(node, offset, parentNodes) {
  parentNodes = parentNodes || [];
  const start = util.locStart(node);
  const end = util.locEnd(node);
  if (start <= offset && offset <= end) {
    for (const childNode of comments.getSortedChildNodes(node)) {
      const childResult = findNodeAtOffset(
        childNode,
        offset,
        [node].concat(parentNodes)
      );
      if (childResult) {
        return childResult;
      }
    }

    if (isSourceElement(node)) {
      return {
        node: node,
        parentNodes: parentNodes
      };
    }
  }
}

// See https://www.ecma-international.org/ecma-262/5.1/#sec-A.5
function isSourceElement(node) {
  if (node == null) {
    return false;
  }
  switch (node.type) {
    case "FunctionDeclaration":
    case "BlockStatement":
    case "BreakStatement":
    case "ContinueStatement":
    case "DebuggerStatement":
    case "DoWhileStatement":
    case "EmptyStatement":
    case "ExpressionStatement":
    case "ForInStatement":
    case "ForStatement":
    case "IfStatement":
    case "LabeledStatement":
    case "ReturnStatement":
    case "SwitchStatement":
    case "ThrowStatement":
    case "TryStatement":
    case "VariableDeclaration":
    case "WhileStatement":
    case "WithStatement":
      return true;
  }
  return false;
}

function calculateRange(text, opts, ast) {
  // Contract the range so that it has non-whitespace characters at its endpoints.
  // This ensures we can format a range that doesn't end on a node.
  const rangeStringOrig = text.slice(opts.rangeStart, opts.rangeEnd);
  const startNonWhitespace = Math.max(
    opts.rangeStart + rangeStringOrig.search(/\S/),
    opts.rangeStart
  );
  let endNonWhitespace;
  for (
    endNonWhitespace = opts.rangeEnd;
    endNonWhitespace > opts.rangeStart;
    --endNonWhitespace
  ) {
    if (text[endNonWhitespace - 1].match(/\S/)) {
      break;
    }
  }

  const startNodeAndParents = findNodeAtOffset(ast, startNonWhitespace);
  const endNodeAndParents = findNodeAtOffset(ast, endNonWhitespace);
  const siblingAncestors = findSiblingAncestors(
    startNodeAndParents,
    endNodeAndParents
  );
  const startNode = siblingAncestors.startNode;
  const endNode = siblingAncestors.endNode;
  const rangeStart = Math.min(util.locStart(startNode), util.locStart(endNode));
  const rangeEnd = Math.max(util.locEnd(startNode), util.locEnd(endNode));

  return {
    rangeStart: rangeStart,
    rangeEnd: rangeEnd
  };
}

function formatRange(text, opts, ast) {
  if (0 < opts.rangeStart || opts.rangeEnd < text.length) {
    const range = calculateRange(text, opts, ast);
    const rangeStart = range.rangeStart;
    const rangeEnd = range.rangeEnd;
    const rangeString = text.slice(rangeStart, rangeEnd);

    // Try to extend the range backwards to the beginning of the line.
    // This is so we can detect indentation correctly and restore it.
    // Use `Math.min` since `lastIndexOf` returns 0 when `rangeStart` is 0
    const rangeStart2 = Math.min(
      rangeStart,
      text.lastIndexOf("\n", rangeStart) + 1
    );
    const indentString = text.slice(rangeStart2, rangeStart);

    const alignmentSize = util.getAlignmentSize(indentString, opts.tabWidth);

    const rangeFormatted = format(
      rangeString,
      Object.assign({}, opts, {
        rangeStart: 0,
        rangeEnd: Infinity,
        printWidth: opts.printWidth - alignmentSize
      }),
      alignmentSize
    );

    // Since the range contracts to avoid trailing whitespace,
    // we need to remove the newline that was inserted by the `format` call.
    const rangeTrimmed = rangeFormatted.trimRight();

    return text.slice(0, rangeStart) + rangeTrimmed + text.slice(rangeEnd);
  }
}

function formatWithShebang(text, opts) {
  if (!text.startsWith("#!")) {
    return format(text, opts);
  }

  const index = text.indexOf("\n");
  const shebang = text.slice(0, index + 1);
  const programText = text.slice(index + 1);
  const nextChar = text.charAt(index + 1);
  const newLine = nextChar === "\n" ? "\n" : nextChar === "\r" ? "\r\n" : "";

  return shebang + newLine + format(programText, opts);
}

module.exports = {
  format: function(text, opts) {
    return formatWithShebang(text, normalizeOptions(opts));
  },
  check: function(text, opts) {
    try {
      const formatted = formatWithShebang(text, normalizeOptions(opts));
      return formatted === text;
    } catch (e) {
      return false;
    }
  },
  version: version,
  __debug: {
    parse: function(text, opts) {
      return parser.parse(text, opts);
    },
    formatAST: function(ast, opts) {
      opts = normalizeOptions(opts);
      const doc = printAstToDoc(ast, opts);
      const str = printDocToString(doc, opts);
      return str;
    },
    // Doesn't handle shebang for now
    formatDoc: function(doc, opts) {
      opts = normalizeOptions(opts);
      const debug = printDocToDebug(doc);
      const str = format(debug, opts);
      return str;
    },
    printToDoc: function(text, opts) {
      opts = normalizeOptions(opts);
      const ast = parser.parse(text, opts);
      attachComments(text, ast, opts);
      const doc = printAstToDoc(ast, opts);
      return doc;
    },
    printDocToString: function(doc, opts) {
      opts = normalizeOptions(opts);
      const str = printDocToString(doc, opts);
      return str;
    }
  }
};
