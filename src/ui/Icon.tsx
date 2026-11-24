import { ArrowLeft, ArrowRight, Boxes, CircleCheck, ClipboardCheck, FilePlus2,
  Download, Files, House, ListOrdered, Mic, Package, Save, ScanSearch, ShieldCheck, UserRound } from 'lucide-react';

const icons = {
  home: House, submit: FilePlus2, reviews: ClipboardCheck, leaderboard: ListOrdered,
  profile: UserRound, reports: Files, dictate: Mic, download: Download, mark: Boxes, equipment: Package, problem: ScanSearch,
  outcome: ShieldCheck, done: CircleCheck, back: ArrowLeft, next: ArrowRight, save: Save,
};

export function Icon({ name }: { name: keyof typeof icons }) {
  const Glyph = icons[name];
  return <Glyph aria-hidden="true" size={22} strokeWidth={1.7} />;
}
