import type { Metadata } from "next";
import { Backdrop } from "../_components/Backdrop";
import { StatsPage } from "../_components/StatsPage";

export const metadata: Metadata = { title: "Your stats · Geo-rarity" };

export default function Page() {
  return (<><Backdrop /><StatsPage /></>);
}
