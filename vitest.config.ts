import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
	test: {
		globals: true,
		alias: {
			obsidian: path.resolve(__dirname, "tests/obsidian-mock.ts"),
		},
	},
});
