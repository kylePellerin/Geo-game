/**
 * Display names for anonymous players on leaderboards: "Brave Albatross 42", derived from the
 * player id (stable, no personal data, nothing typed by players so nothing to moderate).
 */
import { createHash } from "node:crypto";

const ADJECTIVES = [
  "Brave", "Swift", "Curious", "Daring", "Lucky", "Clever", "Wandering", "Bold", "Quiet", "Sunny",
  "Windy", "Misty", "Polar", "Tropical", "Coastal", "Alpine", "Rapid", "Gentle", "Restless", "Keen",
  "Nimble", "Plucky", "Roving", "Steady", "Hardy", "Merry", "Jolly", "Witty", "Eager", "Calm",
  "Golden", "Silver", "Crimson", "Emerald", "Amber", "Cobalt", "Scarlet", "Ivory", "Jade", "Copper",
  "Northern", "Southern", "Eastern", "Western", "Distant", "Hidden", "Lofty", "Sandy", "Snowy", "Stormy",
  "Breezy", "Starry", "Mighty", "Tiny", "Grand", "Noble", "Rustic", "Salty", "Spicy", "Zesty",
  "Cosmic", "Valiant", "Fearless", "Intrepid",
];
const NOUNS = [
  "Albatross", "Navigator", "Explorer", "Voyager", "Nomad", "Pilot", "Sailor", "Pathfinder",
  "Cartographer", "Wayfarer", "Rover", "Pioneer", "Globetrotter", "Mapmaker", "Trailblazer", "Drifter",
  "Condor", "Falcon", "Puffin", "Penguin", "Llama", "Yak", "Camel", "Gecko",
  "Kiwi", "Toucan", "Lemur", "Ibex", "Orca", "Narwhal", "Tortoise", "Pelican",
  "Compass", "Atlas", "Lighthouse", "Glacier", "Volcano", "Canyon", "Fjord", "Lagoon",
  "Monsoon", "Tundra", "Savanna", "Oasis", "Archipelago", "Delta", "Mesa", "Steppe",
  "Balloonist", "Courier", "Ranger", "Scout", "Skipper", "Stowaway", "Surveyor", "Tracker",
  "Caravan", "Zeppelin", "Kayak", "Schooner", "Sherpa", "Seafarer", "Traveller", "Wanderer",
];

export function displayName(playerId: string): string {
  const h = createHash("sha256").update(`gr-name:${playerId}`).digest();
  const adj = ADJECTIVES[h[0] % ADJECTIVES.length];
  const noun = NOUNS[h[1] % NOUNS.length];
  return `${adj} ${noun} ${10 + (h.readUInt16BE(2) % 90)}`;
}
