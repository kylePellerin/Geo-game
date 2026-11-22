import type { Metadata } from "next";
import { Backdrop } from "../_components/Backdrop";
import { Practice } from "../_components/Practice";

export const metadata: Metadata = { title: "Practice · Geo-rarity" };

export default function Page() {
  return (<><Backdrop /><Practice /></>);
}
