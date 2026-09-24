// Configuración plana (flat config) de ESLint 9+.
// Base recomendada de ESLint + typescript-eslint, con el foco puesto en
// detectar usos de APIs marcadas como @deprecated (p. ej. params legacy de zod 4).
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "src/generated/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "prisma/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parserOptions: {
        // Necesario para reglas con tipo de información como no-deprecated
        // (detecta JSDoc @deprecated en APIs de zod, express, prisma, etc.).
        projectService: true,
      },
    },
    rules: {
      "@typescript-eslint/no-deprecated": "error",
      // `_next` del middleware de error de Express no se usa pero debe
      // mantenerse: la aridad de 4 parámetros es lo que lo hace error middleware.
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Los archivos de test usan `any` a propósito para mocks y fixtures.
    // El foco de este linter son las deprecaciones; la estrictez de tipos en
    // pruebas queda fuera del alcance.
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);