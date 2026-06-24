import typescriptEslint from "typescript-eslint";

export default [{
  files: ["**/*.ts"],
}, {
  plugins: {
    "@typescript-eslint": typescriptEslint.plugin,
  },

  languageOptions: {
    parser: typescriptEslint.parser,
    ecmaVersion: 2022,
    sourceType: "module",
  },

  rules: {
    "@typescript-eslint/naming-convention": ["warn", {
      selector: "import",
      format: ["camelCase", "PascalCase"],
    }],

    curly: "warn",
    eqeqeq: "warn",
    "no-throw-literal": "warn",
    semi: "warn",
  },
}, {
  // Enforce the layering: the API layer must stay free of VS Code APIs so it
  // remains portable and unit-testable without the extension host.
  files: ["src/api/**/*.ts"],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [{
        name: "vscode",
        message: "The api/ layer must not depend on the vscode API. Keep VS Code logic in ui/.",
      }],
    }],
  },
}];
