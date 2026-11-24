/**
 * Per-card art crops for the live card frame. The printed art has a cost/name strip on the left
 * and stat boxes + text at the bottom; the illustration is the area right of the strip and above
 * the boxes. `fy` is the subject's vertical focus (fraction of the image height, kept centred in
 * the art window when possible); `z` is the zoom (image width as a multiple of the window width —
 * just enough to push the left strip out of view).
 */
export interface Crop {
  fy: number;
  z: number;
}

const UNIT = 1.19; // hides the left strip (x < 16%)
const WIDE = 1.08; // Creation Units / Creation Oracle: thinner strip

export const CROPS: Record<string, Crop> = {
  'cards/BU_DSH': { fy: 0.33, z: UNIT }, 'cards/BU_JPA': { fy: 0.36, z: UNIT }, 'cards/BU_LS': { fy: 0.35, z: UNIT },
  'cards/BU_SA': { fy: 0.45, z: UNIT }, 'cards/BU_SC': { fy: 0.35, z: UNIT }, 'cards/BU_TS': { fy: 0.4, z: UNIT },
  'cards/BU_AD': { fy: 0.35, z: UNIT }, 'cards/BU_BM': { fy: 0.35, z: UNIT }, 'cards/BU_JP': { fy: 0.36, z: UNIT },
  'cards/BU_KC': { fy: 0.3, z: UNIT }, 'cards/BU_LP': { fy: 0.4, z: UNIT }, 'cards/BU_TI': { fy: 0.35, z: UNIT },
  'cards/BU_ZM': { fy: 0.4, z: UNIT }, 'cards/BU_DC': { fy: 0.38, z: UNIT }, 'cards/BU_HB': { fy: 0.4, z: UNIT },
  'cards/BU_LQ': { fy: 0.38, z: UNIT }, 'cards/BU_NA': { fy: 0.4, z: UNIT }, 'cards/BU_TB': { fy: 0.42, z: UNIT },
  'cards/EQ_CO': { fy: 0.35, z: UNIT }, 'cards/EQ_KA': { fy: 0.4, z: UNIT }, 'cards/EQ_MS': { fy: 0.35, z: UNIT },
  'cards/EQ_PA': { fy: 0.38, z: UNIT }, 'cards/EQ_PB': { fy: 0.35, z: UNIT }, 'cards/EQ_VCS': { fy: 0.36, z: UNIT },
  'cards/PW_CR': { fy: 0.4, z: UNIT }, 'cards/PW_EH': { fy: 0.33, z: UNIT }, 'cards/PW_EM': { fy: 0.38, z: UNIT },
  'cards/PW_HEP': { fy: 0.42, z: UNIT }, 'cards/PW_RR': { fy: 0.35, z: UNIT }, 'cards/TR_GSF': { fy: 0.3, z: UNIT },
  'cards/RS_CO': { fy: 0.36, z: WIDE }, 'cards/CU_BA': { fy: 0.36, z: WIDE }, 'cards/CU_DS': { fy: 0.36, z: WIDE },
  'cards/CU_MA': { fy: 0.36, z: WIDE }, 'cards/CU_NG': { fy: 0.34, z: WIDE },
  'cards/BU_FB': { fy: 0.38, z: UNIT }, 'cards/BU_GS': { fy: 0.4, z: UNIT }, 'cards/BU_WR': { fy: 0.38, z: UNIT },
  'cards/BU_BC': { fy: 0.35, z: UNIT }, 'cards/BU_UO': { fy: 0.38, z: UNIT }, 'cards/BU_VC': { fy: 0.35, z: UNIT },
  'cards/BU_PI': { fy: 0.38, z: UNIT }, 'cards/BU_SS': { fy: 0.38, z: UNIT }, 'cards/BU_TG': { fy: 0.38, z: UNIT },
  'cards/BU_XP': { fy: 0.35, z: UNIT }, 'cards/PW_MD': { fy: 0.35, z: UNIT },
};

export function cropFor(art: string | undefined): Crop {
  return (art && CROPS[art]) || { fy: 0.37, z: art?.includes('/CU_') || art?.includes('/RS_') ? WIDE : UNIT };
}
