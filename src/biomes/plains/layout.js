// Geography of the plains above Lago Skottsberg (between Campamento Italiano
// and Paine Grande), in metres. World axes: +X east, -Z north; azimuths are
// degrees clockwise from north. The walker starts on the trail at the origin,
// looking up the French Valley; the low evening sun stands behind the left
// shoulder (WSW), so the Cuernos glow while Paine Grande's flank is in shade.
//
// Everything that defines the landscape lives here, so the scene can be
// re-composed by editing numbers: ridge lines, peak heights, the lake outline
// and the trail.

const D2R = Math.PI / 180;

// polar (azimuth, distance) -> world xz
export const polar = ( az, d ) => [ Math.sin( az * D2R ) * d, - Math.cos( az * D2R ) * d ];

export const FORWARD_AZ = 25; // the French Valley, straight up the trail

// --- the trail (gravel path), meandering along FORWARD_AZ through the origin
export const TRAIL = {
	az: FORWARD_AZ,
	halfWidth: 0.42, // gravel bed
	verge: 0.55, // trampled, sparse grass on both sides
	// lateral meander: sum of sines of the along-trail coordinate (a)
	waves: [ [ 5.5, 41 ], [ 2.2, 13.5 ], [ 0.6, 4.3 ] ], // [amplitude m, wavelength/2π m]
	depth: 0.06, // the bed is trodden slightly into the ground
};

// --- Lago Skottsberg: a turquoise lake below the plains, to the east / south-east
export const LAKE = {
	level: - 58,
	depth: 40,
	// axis of the lake (polyline) and half-widths along it
	axis: [ polar( 168, 820 ), polar( 140, 1150 ), polar( 112, 1650 ), polar( 92, 2350 ), polar( 74, 3100 ) ],
	halfWidth: [ 420, 640, 760, 800, 700 ],
	bank: 260, // width of the slope from the plains down to the shore
};

// --- mountain massifs: crest polylines with heights (m above the plains)
// Cerro Paine Grande: a huge dark wall NW / W with hanging glaciers
export const PAINE_GRANDE = {
	crest: [
		[ ...polar( - 120, 2900 ), 700 ],
		[ ...polar( - 98, 2500 ), 1050 ],
		[ ...polar( - 78, 2250 ), 1250 ],
		[ ...polar( - 58, 2120 ), 1420 ],
		[ ...polar( - 40, 2080 ), 1560 ], // main summit, often in cloud
		[ ...polar( - 22, 2180 ), 1380 ],
		[ ...polar( - 6, 2450 ), 1150 ],
		[ ...polar( 8, 2950 ), 900 ],
		[ ...polar( 16, 3700 ), 650 ],
	],
	width: 1050, // horizontal distance from crest to the foot of the slope
	steep: 1.25, // profile exponent (>1 = concave, cliffy upper walls)
	jag: 0.33, // relative amplitude of the ridged (jagged) detail
	glacier: { az: - 52, d: 1900, size: 520 }, // Glaciar Francés hanging below the summit
};

// Los Cuernos del Paine: light granite towers with a dark sediment cap, across the lake
export const CUERNOS = {
	crest: [
		[ ...polar( 40, 4700 ), 650 ],
		[ ...polar( 50, 4150 ), 1250 ],
		[ ...polar( 58, 3900 ), 1520 ], // Cuerno Principal
		[ ...polar( 66, 3820 ), 1460 ],
		[ ...polar( 75, 3850 ), 1580 ], // Cuerno Este
		[ ...polar( 86, 4000 ), 1380 ],
		[ ...polar( 98, 4350 ), 1080 ],
		[ ...polar( 112, 4900 ), 700 ],
	],
	width: 950,
	steep: 1.7, // sheer granite walls
	jag: 0.42,
	capBase: 1020, // height (above the plains) where the dark cap starts
	// the towers themselves: [azimuth, distance, top height, radius, horn height]
	towers: [
		[ 55, 3950, 1380, 330, 260 ], // Cuerno Principal
		[ 63, 3870, 1300, 260, 200 ], // Cuerno Central
		[ 72, 3880, 1420, 340, 230 ], // Cuerno Este
		[ 47, 4250, 1100, 300, 160 ],
		[ 82, 3980, 1150, 280, 150 ],
	],
};

// Distant pale massif up the French Valley (Cerro Fortaleza / Catedral side)
export const VALLEY_HEAD = {
	crest: [
		[ ...polar( 12, 8200 ), 1200 ],
		[ ...polar( 22, 7800 ), 1800 ],
		[ ...polar( 31, 8300 ), 1650 ],
		[ ...polar( 40, 9000 ), 1100 ],
	],
	width: 2200,
	steep: 1.3,
	jag: 0.3,
};

// Low ranges closing the horizon behind (south / south-west / west)
export const FAR_HILLS = {
	crest: [
		[ ...polar( 150, 9000 ), 260 ],
		[ ...polar( 185, 8000 ), 420 ],
		[ ...polar( 215, 9000 ), 380 ],
		[ ...polar( 245, 10000 ), 560 ],
		[ ...polar( 270, 8500 ), 720 ],
		[ ...polar( 290, 6000 ), 900 ],
	],
	width: 3200,
	steep: 1.1,
	jag: 0.18,
};

// Mountain detail never reaches the walkable plains (the GPU terrain used for
// the grass omits it); it fades in beyond this distance from the origin.
export const MOUNTAIN_FREE_RADIUS = 950;
// The walker is kept within this radius of the origin.
export const WALK_RADIUS = 260;
