/** Session names: short, distinct, easy to say. One per session, unique on the board. */
const POOL = [
  'Acorn', 'Agate', 'Aiko', 'Akira', 'Alder', 'Amber', 'Anise', 'Arlo', 'Ash', 'Aspen',
  'Aster', 'Atlas', 'Azure', 'Basil', 'Bay', 'Beck', 'Birch', 'Bodhi', 'Bram', 'Briar',
  'Brook', 'Bryn', 'Cade', 'Calla', 'Cass', 'Cedar', 'Clover', 'Coral', 'Cove', 'Crane',
  'Cress', 'Dale', 'Dara', 'Delta', 'Dove', 'Dune', 'Echo', 'Eden', 'Elm', 'Ember',
  'Emi', 'Esme', 'Fable', 'Fawn', 'Fennel', 'Fern', 'Fig', 'Finch', 'Fjord', 'Flint',
  'Flora', 'Frost', 'Gale', 'Garnet', 'Ginger', 'Glen', 'Hana', 'Haru', 'Haven', 'Hawk',
  'Hazel', 'Heath', 'Heron', 'Hiro', 'Holly', 'Ibis', 'Indigo', 'Iris', 'Isla', 'Ivy',
  'Jade', 'Jasper', 'Jay', 'Jun', 'Juniper', 'Juno', 'Kaede', 'Kai', 'Kestrel', 'Kira',
  'Kit', 'Koa', 'Koji', 'Lake', 'Lark', 'Laurel', 'Leif', 'Lilac', 'Linden', 'Lotus',
  'Lumi', 'Luna', 'Lyra', 'Mako', 'Maple', 'Marlow', 'Mesa', 'Mika', 'Milo', 'Mint',
  'Miso', 'Momo', 'Mori', 'Moss', 'Myrtle', 'Nami', 'Nara', 'Nico', 'Noor', 'Nova',
  'Oak', 'Olive', 'Onyx', 'Opal', 'Oriel', 'Orin', 'Orla', 'Osprey', 'Otter', 'Pax',
  'Pearl', 'Peony', 'Perry', 'Pike', 'Pine', 'Piper', 'Plum', 'Poppy', 'Quill', 'Rain',
  'Reed', 'Ren', 'Rhea', 'Riku', 'Rio', 'Robin', 'Rook', 'Rowan', 'Rue', 'Rumi',
  'Sable', 'Saffron', 'Sage', 'Shiso', 'Skye', 'Sol', 'Sora', 'Sorrel', 'Sparrow', 'Suki',
  'Sumi', 'Tansy', 'Taro', 'Teal', 'Thistle', 'Thorn', 'Thyme', 'Tide', 'Toby', 'Tomo',
  'Tula', 'Umi', 'Vale', 'Vesper', 'Wilder', 'Willow', 'Wren', 'Yarrow', 'Yoshi', 'Yuki',
  'Yuzu', 'Zara', 'Zephyr', 'Zinnia',
  'Adair', 'Alba', 'Alma', 'Alto', 'Amara', 'Anja', 'Ansel', 'Arden', 'Aria', 'Arrow',
  'Auburn', 'Auden', 'Aurora', 'Aven', 'Avril', 'Azalea', 'Balsa', 'Bamboo', 'Beryl', 'Blair',
  'Bloom', 'Blue', 'Breeze', 'Brent', 'Brio', 'Bronze', 'Callum', 'Camellia', 'Canary', 'Canyon',
  'Capri', 'Caraway', 'Carmine', 'Casper', 'Celeste', 'Cerise', 'Chai', 'Chervil', 'Chloe', 'Cinder',
  'Citrine', 'Clay', 'Cleo', 'Cliff', 'Cloud', 'Cobalt', 'Cocoa', 'Copper', 'Cosmo', 'Cricket',
  'Cypress', 'Dahlia', 'Daisy', 'Dapple', 'Dawn', 'Della', 'Denim', 'Dew', 'Dill', 'Dorian',
  'Drake', 'Drift', 'Dusk', 'Ebony', 'Eider', 'Elio', 'Ellis', 'Elowen', 'Enzo', 'Etta',
  'Ever', 'Falcon', 'Farley', 'Felix', 'Fenna', 'Ferris', 'Field', 'Fleur', 'Flo', 'Forest',
  'Fox', 'Freesia', 'Gaia', 'Gem', 'Ginkgo', 'Goldie', 'Grebe', 'Greer', 'Grove', 'Gull',
  'Halcyon', 'Halo', 'Harbor', 'Hattie', 'Helio', 'Henna', 'Hollis', 'Honey', 'Hop', 'Hyacinth',
  'Ida', 'Ilya', 'Imogen', 'Ines', 'Iona', 'Irwin', 'Ivory', 'Izumi', 'Jacaranda', 'Jasmine',
  'Jem', 'Jet', 'Joan', 'Jolie', 'Jonah', 'Jory', 'Joy', 'Jules', 'Karma', 'Keiko',
  'Kelso', 'Kenton', 'Kiko', 'Kilian', 'Kiri', 'Kite', 'Kumi', 'Lagoon', 'Lana', 'Lapis',
  'Larch', 'Larkspur', 'Lava', 'Lavender', 'Lemon', 'Lena', 'Lichen', 'Lido', 'Lily', 'Linnea',
  'Lior', 'Loam', 'Lottie', 'Lucent', 'Lucia', 'Lupin', 'Lynx', 'Mabel', 'Madder', 'Magnolia',
  'Mallow', 'Manta', 'Marble', 'Margot', 'Marigold', 'Marl', 'Mavis', 'Meadow', 'Merle', 'Mica',
  'Milan', 'Mira', 'Mist', 'Mocha', 'Moon', 'Nacre', 'Nell', 'Neroli', 'Nessa', 'Nettle',
  'Nila', 'Nori', 'Nyla', 'Oasis', 'Ochre', 'Oleander', 'Oona', 'Orchid', 'Ori', 'Oriole',
  'Orson', 'Oslo', 'Owen', 'Paloma', 'Pansy', 'Paprika', 'Pascal', 'Pebble', 'Pecan', 'Petal',
  'Petra', 'Phlox', 'Pimento', 'Pipit', 'Pollen', 'Pond', 'Posy', 'Primrose', 'Prism', 'Puffin',
  'Quartz', 'Quince', 'Raffi', 'Raina', 'Raven', 'Ray', 'Reef', 'Remy', 'Ridge', 'Rill',
  'River', 'Roan', 'Romy', 'Rosa', 'Rosin', 'Ruby', 'Rye', 'Sakura', 'Salix', 'Samara',
  'Sander', 'Satin', 'Scout', 'Sedum', 'Selma', 'Senna', 'Sequoia', 'Shale', 'Shell', 'Shore',
  'Sienna', 'Silas', 'Silva', 'Silver', 'Slate', 'Snow', 'Sonnet', 'Spruce', 'Starling', 'Stella',
  'Stone', 'Storm', 'Swan', 'Sylvie', 'Tamar', 'Tawny', 'Terra', 'Tess', 'Tiger', 'Topaz',
  'Trill', 'Tulip', 'Tundra', 'Umber', 'Ursa', 'Valley', 'Veda', 'Verbena', 'Vervain', 'Viola',
  'Violet', 'Vireo', 'Vista', 'Walnut', 'Wave', 'West', 'Wheat', 'Willa', 'Winter', 'Wisteria',
  'Woodbine', 'Xanthe', 'Yara', 'Yew', 'Yonder', 'Zelia', 'Zeno', 'Zia', 'Zora', 'Zuri',
];

/**
 * A name not taken now. Names in `recent` (sessions that ended lately, closed conversations)
 * are avoided while the pool has others, so a new session rarely repeats a name just seen.
 */
export function pickName(taken: Set<string>, random: () => number = Math.random, recent: Iterable<string> = []): string {
  const normalized = new Set([...taken].map(name => name.toLowerCase()));
  const free = POOL.filter((name) => !normalized.has(name.toLowerCase()));
  const lately = new Set([...recent].map(name => name.toLowerCase()));
  const fresh = free.filter((name) => !lately.has(name.toLowerCase()));
  const choice = fresh.length > 0 ? fresh : free;
  if (choice.length > 0) return choice[Math.floor(random() * choice.length)]!;
  for (let n = 2; ; n++) {
    const name = `${POOL[Math.floor(random() * POOL.length)]}${n}`;
    if (!normalized.has(name.toLowerCase())) return name;
  }
}
