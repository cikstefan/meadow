// Minimal world switcher: a small frosted pill at the top centre. Choosing the
// other world reloads the page with ?world=… (every other URL setting is kept),
// so each world starts clean with its own defaults.

export function mountWorldSwitch( biomes, current ) {

	const css = document.createElement( 'style' );
	css.textContent = `
	#worlds{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:4;display:flex;gap:2px;padding:3px;
		border-radius:999px;background:#0005;border:1px solid #fff2;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);
		font:11px/1 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;letter-spacing:.04em;opacity:.7;transition:opacity .2s}
	#worlds:hover{opacity:1}
	#worlds button{all:unset;cursor:pointer;color:#f2efe6;padding:6px 11px;border-radius:999px;opacity:.65;transition:background .2s,opacity .2s}
	#worlds button:hover{opacity:1}
	#worlds button[aria-pressed=true]{background:#ffffff26;opacity:1;cursor:default}
	`;
	document.head.appendChild( css );

	const nav = document.createElement( 'nav' );
	nav.id = 'worlds';
	nav.setAttribute( 'aria-label', 'World' );
	const order = [ 'plains', 'meadow' ];
	for ( const id of order ) {

		const b = biomes[ id ];
		if ( ! b ) continue;
		const btn = document.createElement( 'button' );
		btn.type = 'button';
		btn.textContent = b.name;
		btn.setAttribute( 'aria-pressed', b === current ? 'true' : 'false' );
		btn.addEventListener( 'pointerdown', ( e ) => e.stopPropagation() );
		btn.addEventListener( 'click', ( e ) => {

			e.stopPropagation();
			if ( b === current ) return;
			const p = new URLSearchParams( location.search );
			p.set( 'world', id );
			// world-specific look settings shouldn't leak across worlds
			for ( const k of [ 'hour', 'clouds', 'wind', 'winddir', 'grass', 'dry', 'mist', 'particles', 'spirits', 'shafts', 'view' ] ) p.delete( k );
			location.search = p.toString();

		} );
		nav.appendChild( btn );

	}

	document.body.appendChild( nav );

}
