import type { Metadata } from "next";
import { Backdrop } from "../_components/Backdrop";
import { Shell } from "../_components/Shell";

export const metadata: Metadata = { title: "Credits · Geo-rarity" };

/** Attribution obligations: keep in step with "Credits page list" in pipeline/SOURCES.md. */
const CREDITS: [string, string, string][] = [
  ["Country data", "© mledoze/countries contributors", "ODbL 1.0"],
  ["Population and forest data", "The World Bank, World Development Indicators", "CC BY 4.0"],
  ["City data", "GeoNames (geonames.org)", "CC BY 4.0"],
  ["Airport data", "OurAirports", "public domain"],
  ["Places, names and facts", "Wikidata, and Wikimedia pageview statistics", "CC0"],
  ["Flag images", "flag-icons by Panayiotis Lipiridis", "MIT licence"],
  ["World map, outlines and locator maps", "Made with Natural Earth", "public domain"],
  ["Fonts", "Pixelify Sans, Silkscreen and VT323", "SIL Open Font License 1.1"],
  ["QR codes", "node-qrcode by Ryan Day", "MIT licence"],
];

export default function Page() {
  return (
    <>
      <Backdrop />
      <Shell>
        <section className="card prose" aria-labelledby="credits-title">
          <div className="kicker">Credits</div>
          <h2 id="credits-title" className="stats-title">Made with open data</h2>
          <ul className="credits">
            {CREDITS.map(([what, who, licence]) => (
              <li key={what}><b>{what}:</b> {who} <span className="fine">({licence})</span></li>
            ))}
          </ul>
          <p className="fine">Maps and pictures in the game are our own drawings of this data.</p>
        </section>
      </Shell>
    </>
  );
}
