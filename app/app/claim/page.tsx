import type { Metadata } from "next";
import { Backdrop } from "../_components/Backdrop";
import { ClaimPage } from "../_components/ClaimPage";

export const metadata: Metadata = { title: "Enter your code · Geo-rarity" };

export default function Page() {
  return (<><Backdrop /><ClaimPage /></>);
}
