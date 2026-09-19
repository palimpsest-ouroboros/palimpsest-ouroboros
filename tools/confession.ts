/**
 * confession.ts — the forty-two declarations of innocence.
 *
 * SOURCED, verbatim. E. A. Wallis Budge, THE BOOK OF THE DEAD: The Papyrus of Ani
 * (London, 1895), Chapter CXXV, the addresses to the forty-two assessors in the Hall of
 * Maati. Budge's spelling, punctuation and diacritics are kept exactly as printed; they
 * are not modernised here.
 *
 * Public domain: Budge died 1934 and the work was published in 1895, before 1929, so it
 * is public domain in the United States and in life+70 jurisdictions alike.
 *
 * Each declaration is addressed to a named assessor coming from a named place. The count
 * is forty-two because the assessors are forty-two; the list is not padded to reach it.
 */

export const CONFESSION: string[] = [
  "Hail, thou whose strides are long, who comest forth from Annu, I have not done iniquity.",
  "Hail, thou who art embraced by flame, who comest forth from Kher-āba, I have not robbed with violence.",
  "Hail, Fenṭiu, who comest forth from Khemennu, I have not stolen.",
  "Hail, Devourer of the Shade, who comest forth from Qernet, I have done no murder ; I have done no harm.",
  "Hail, Nehau, who comest forth from Re-stau, I have not defrauded offerings.",
  "Hail, god in the form of two lions, who comest forth from heaven, I have not minished oblations.",
  "Hail, thou whose eyes are of fire, who comest forth from Saut, I have not plundered the god.",
  "Hail, thou Flame, which comest and goest, I have spoken no lies.",
  "Hail, Crusher of bones, who comest forth from Suten-ḥenen, I have not snatched away food.",
  "Hail, thou who shootest forth the Flame, who comest forth from Het-Ptaḥ-ka, I have not caused pain.",
  "Hail, Qerer, who comest forth from Amentet, I have not committed fornication.",
  "Hail, thou whose face is turned back, who comest forth from thy hiding place, I have not caused shedding of tears.",
  "Hail, Bast, who comest forth from the secret place, I have not dealt deceitfully.",
  "Hail, thou whose legs are of fire, who comest forth out of the darkness, I have not transgressed.",
  "Hail, Devourer of Blood, who comest forth from the block of slaughter, I have not acted guilefully.",
  "Hail, Devourer of the inward parts, who comest forth from Mābet, I have not laid waste the ploughed land.",
  "Hail, Lord of Right and Truth, who comest forth from the city of Right and Truth, I have not been an eavesdropper.",
  "Hail, thou who dost stride backwards, who comest forth from the city of Bast, I have not set my lips in motion [against any man].",
  "Hail, Sertiu, who comest forth from Annu, I have not been angry and wrathful except for a just cause.",
  "Hail, thou being of two-fold wickedness, who comest forth from Ati (?), I have not defiled the wife of any man.",
  "Hail, thou two-headed serpent, who comest forth from the torture-chamber, I have not defiled the wife of any man.",
  "Hail, thou who dost regard what is brought unto thee, who comest forth from Pa-Amsu, I have not polluted myself.",
  "Hail, thou Chief of the mighty, who comest forth from Amentet, I have not caused terror.",
  "Hail, thou Destroyer, who comest forth from Ḳesiu, I have not transgressed.",
  "Hail, thou who orderest speech, who comest forth from Urit, I have not burned with rage.",
  "Hail, thou Babe, who comest forth from Uab, I have not stopped my ears against the words of Right and Truth.",
  "Hail, Kenemti, who comest forth from Kenemet, I have not worked grief.",
  "Hail, thou who bringest thy offering, I have not acted with insolence.",
  "Hail, thou who orderest speech, who comest forth from Unaseṭ, I have not stirred up strife.",
  "Hail, Lord of faces, who comest forth from Netchfet, I have not judged hastily.",
  "Hail, Sekheriu, who comest forth from Utten, I have not been an eavesdropper.",
  "Hail, Lord of the two horns, who comest forth from Saïs, I have not multiplied words exceedingly.",
  "Hail, Nefer-Tmu, who comest forth from Het-Ptaḥ-ka, I have done neither harm nor ill.",
  "Hail, Tmu in thine hour, who comest forth from Tattu, I have never cursed the king.",
  "Hail, thou who workest with thy will, who comest forth from Tebu, I have never fouled the water.",
  "Hail, thou bearer of the sistrum, who comest forth from Nu, I have not spoken scornfully.",
  "Hail, thou who makest mankind to flourish, who comest forth from Saïs, I have never cursed God.",
  "Hail, Neḥeb-ka, who comest forth from thy hiding place, I have not stolen.",
  "Hail, Neḥeb-nefert, who comest forth from thy hiding place, I have not defrauded the offerings of the gods.",
  "Hail, thou who dost set in order the head, who comest forth from thy shrine, I have not plundered the offerings to the blessed dead.",
  "Hail, thou who bringest thy arm, who comest forth from the city of Maāti, I have not filched the food of the infant, neither have I sinned against the god of my native town.",
  "Hail, thou whose teeth are white, who comest forth from Ta-she, I have not slaughtered with evil intent the cattle of the god.",
];

export const declarationFor = (n: number): string =>
  CONFESSION[((n % CONFESSION.length) + CONFESSION.length) % CONFESSION.length]!;
