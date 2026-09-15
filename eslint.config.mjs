import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['node_modules/**', '.wrangler/**', 'worker-configuration.d.ts'] },
	{
		files: ['src/**/*.ts', 'test/**/*.ts'],
		extends: [eslint.configs.recommended, ...tseslint.configs.recommended],
		rules: {
			'@typescript-eslint/no-unused-vars': ['error', { args: 'none' }],
		},
	},
);
