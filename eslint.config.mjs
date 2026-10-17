// Shared ESLint flat configuration for the whole Holqa monorepo.
//
// Based on the maintainer's preferred @antfu/eslint-config baseline. Deliberate
// deviations from that baseline are documented in
// docs/contributing/code-style.md#eslint-compatibility-notes.
import antfu from "@antfu/eslint-config";
import n from "eslint-plugin-n";
import pathAlias from "eslint-plugin-path-alias";

/** Source files that follow the `style/eol-last: never` convention. */
const codeFiles = ["**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"];

/** Workspace packages that hold Holqa's framework-neutral contracts. */
const neutralPackageSources = [
  "packages/core/src/**",
  "packages/compiler/src/**",
  "packages/sdk/src/**",
  "packages/client/src/**",
  // Disposable M0 experiments that prototype neutral packages obey the same rules.
  "experiments/model/src/**",
  "experiments/sdk/src/**",
  "experiments/schema-adapters/src/**",
  "experiments/compiler/src/**"
];

/** Restricts imports that would reach into another package's private files. */
const noDeepPackageImports = {
  group: ["@holqa/*/src", "@holqa/*/src/**", "@holqa/*/dist", "@holqa/*/dist/**", "**/packages/*/src/**", "**/experiments/*/src/**"],
  message: "Import other Holqa packages through their public entry points (package.json \"exports\"), never their src/ or dist/ files."
};

export default antfu({
  type: "lib",
  formatters: true,
  stylistic: {
    indent: 2,
    semi: true,
    quotes: "double"
  },
  typescript: {
    overrides: {
      "ts/consistent-type-imports": ["error", {
        prefer: "type-imports",
        fixStyle: "separate-type-imports"
      }],
      "ts/no-empty-object-type": "off"
    }
  },
  plugins: {
    "n": n,
    "path-alias": pathAlias
  }
}, {
  ignores: [
    "**/dist/**",
    "**/node_modules/**",
    "**/coverage/**",
    "**/build/**",
    "**/.output/**",
    "**/.tanstack/**",
    "**/.vite/**",
    "**/.turbo/**",
    "**/*.css",
    "**/*.html",
    "**/*.md",
    "**/src/routeTree.gen.ts",
    "**/src/generated/**",
    "LICENSE"
  ]
}, {
  rules: {
    "node/prefer-global/process": ["error", "always"],
    "node/prefer-global/buffer": ["error", "always"],
    "style/comma-dangle": ["error", "never"],
    "style/no-extra-semi": "error",
    "style/semi": ["error", "always"],
    "style/semi-spacing": ["error", {
      before: false,
      after: true
    }],
    "style/quotes": ["error", "double", {
      allowTemplateLiterals: "always"
    }],
    "style/keyword-spacing": ["error", {
      before: true,
      after: true
    }],
    "style/space-before-blocks": ["error", "always"],
    "style/indent": ["error", 2],
    "curly": ["error", "multi-or-nest", "consistent"],
    "style/brace-style": ["error", "1tbs", {
      allowSingleLine: false
    }],
    "style/key-spacing": ["error", {
      beforeColon: false,
      afterColon: true,
      mode: "strict"
    }],
    "style/jsx-quotes": ["error", "prefer-double"],
    "style/arrow-spacing": "error",
    "style/switch-colon-spacing": "error",
    "antfu/curly": "off",
    "prefer-const": ["error", {
      destructuring: "all",
      ignoreReadBeforeAssign: true
    }],
    "style/object-curly-newline": ["error", {
      ImportDeclaration: {
        multiline: true,
        minProperties: 2
      },
      ExportDeclaration: {
        multiline: true,
        minProperties: 3
      }
    }],

    "no-undef": "off",

    "perfectionist/sort-imports": "error",

    "path-alias/no-relative": ["error", {
      exceptions: ["*.css"]
    }],

    "no-restricted-imports": ["error", {
      patterns: [noDeepPackageImports]
    }]
  }
}, {
  // Holqa source files never end with a trailing newline. Data files (JSON,
  // YAML, Markdown) keep the newline that pnpm, Changesets and other tools write.
  files: codeFiles,
  rules: {
    "style/eol-last": ["error", "never"]
  }
}, {
  // Function summary requirement (C#-style XML docs equivalent). See
  // docs/contributing/code-style.md#documentation-comments.
  files: ["**/*.{ts,tsx,mts,cts}"],
  ignores: ["**/*.d.ts", "**/tsdown.config.ts"],
  rules: {
    "jsdoc/require-jsdoc": ["error", {
      publicOnly: false,
      require: {
        FunctionDeclaration: true,
        MethodDefinition: true,
        ClassDeclaration: true,
        ArrowFunctionExpression: false,
        FunctionExpression: false
      },
      contexts: [
        // Named arrow functions and function expressions: `const parse = () => {}`.
        "VariableDeclarator > ArrowFunctionExpression",
        "VariableDeclarator > FunctionExpression",
        // Exported types, interfaces and constants form the public API.
        "ExportNamedDeclaration[declaration.type='TSInterfaceDeclaration']",
        "ExportNamedDeclaration[declaration.type='TSTypeAliasDeclaration']",
        "ExportNamedDeclaration[declaration.type='VariableDeclaration']"
      ],
      // Never auto-insert empty stubs: summaries must be written deliberately.
      enableFixer: false,
      checkConstructors: true,
      checkGetters: true,
      checkSetters: true
    }],
    "jsdoc/require-description": ["error", {
      contexts: ["FunctionDeclaration", "MethodDefinition", "ClassDeclaration", "VariableDeclarator > ArrowFunctionExpression", "VariableDeclarator > FunctionExpression"]
    }],
    "jsdoc/require-param": ["error", { checkDestructured: false }],
    "jsdoc/require-param-description": "error",
    "jsdoc/require-returns": ["error", { checkGetters: false }],
    "jsdoc/require-returns-description": "error",
    "jsdoc/require-param-type": "off",
    "jsdoc/require-returns-type": "off",
    "jsdoc/no-types": "error",
    "jsdoc/informative-docs": "error",
    "jsdoc/tag-lines": ["error", "any", { startLines: 1 }]
  }
}, {
  // Tests belong under <package>/tests/, mirroring src/.
  files: ["**/src/**/*.{test,spec}.{ts,tsx}"],
  rules: {
    "no-restricted-syntax": ["error", {
      selector: "Program",
      message:
        "Tests belong under tests/, mirroring the src/ path. For example, src/a/b.ts must be tested by tests/a/b.test.ts."
    }]
  }
}, {
  // Framework-neutral packages must not depend on a runtime or on execution layers.
  files: neutralPackageSources,
  rules: {
    "no-restricted-imports": ["error", {
      paths: [
        { name: "bun", message: "Framework-neutral packages must not depend on Bun APIs. Use @holqa/runtime-bun." }
      ],
      patterns: [
        noDeepPackageImports,
        { group: ["bun:*", "node:*"], message: "Framework-neutral packages must not import runtime-specific modules." },
        { group: ["@holqa/runtime-*", "@holqa/local", "@holqa/cli", "@holqa/testing"], message: "Framework-neutral packages must not depend on runtime, tooling or testing packages." }
      ]
    }]
  }
}, {
  files: ["packages/core/src/**"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [
        { name: "bun", message: "@holqa/core must not depend on Bun APIs." }
      ],
      patterns: [
        { group: ["@holqa/*"], message: "@holqa/core is the innermost package and must not depend on other Holqa packages." },
        { group: ["bun:*", "node:*"], message: "@holqa/core must not import runtime-specific modules." }
      ]
    }]
  }
}, {
  files: ["packages/sdk/src/**", "packages/client/src/**", "experiments/sdk/src/**"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [
        { name: "bun", message: "Public SDK/client code must stay runtime-neutral." }
      ],
      patterns: [
        noDeepPackageImports,
        { group: ["bun:*", "node:*"], message: "Public SDK/client code must stay runtime-neutral." },
        { group: ["@holqa/compiler", "@holqa/compiler/*"], message: "The public SDK and client must not import compiler internals." },
        { group: ["@holqa/runtime-*", "@holqa/local", "@holqa/cli", "@holqa/testing"], message: "The public SDK and client must not depend on runtime, tooling or testing packages." }
      ]
    }]
  }
}, {
  // M0 experiments mirror the target layering: the compiler, runtime, model and
  // schema-adapter prototypes must not see the SDK prototype, not even through
  // type-only imports (which scripts/check-boundaries.ts cannot detect).
  files: ["experiments/model/src/**", "experiments/schema-adapters/src/**", "experiments/compiler/src/**"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [
        { name: "bun", message: "Framework-neutral packages must not depend on Bun APIs. Use @holqa/runtime-bun." }
      ],
      patterns: [
        noDeepPackageImports,
        { group: ["bun:*", "node:*"], message: "Framework-neutral packages must not import runtime-specific modules." },
        { group: ["@holqa/runtime-*", "@holqa/local", "@holqa/cli", "@holqa/testing"], message: "Framework-neutral packages must not depend on runtime, tooling or testing packages." },
        { group: ["@holqa/experiment-sdk", "@holqa/experiment-runtime-bun"], message: "Only the descriptor contracts are shared; the SDK and runtime prototypes are out of bounds here." }
      ]
    }]
  }
}, {
  files: ["experiments/runtime-bun/src/**"],
  rules: {
    "no-restricted-imports": ["error", {
      patterns: [
        noDeepPackageImports,
        { group: ["@holqa/experiment-sdk", "@holqa/experiment-compiler"], message: "The runtime prototype works from model descriptors only." }
      ]
    }]
  }
}, {
  // Configuration and maintainer scripts run as programs, not shipped library code.
  files: ["scripts/**", "**/tsdown.config.ts", "eslint.config.mjs"],
  rules: {
    "no-console": "off"
  }
});