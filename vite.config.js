import { defineConfig } from 'vite';

export default defineConfig( {
	base: './',
	build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
	assetsInclude: [ '**/*.glb' ],
	server: { host: true },
} );
