import { useNavigation } from "@react-navigation/native";
import { Linking, Pressable } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { isLegalDocumentUrl, LEGAL_URL } from "../lib/legal-document-url";

export function SettingsLegalDocumentCloseHeaderButton() {
  const navigation = useNavigation();

  return (
    <Pressable
      accessibilityLabel="Close legal document"
      accessibilityRole="button"
      hitSlop={12}
      onPress={() => navigation.goBack()}
      className="p-2 active:opacity-60"
    >
      <SymbolView
        name="xmark"
        size={18}
        tintColorClassName={"accent-icon"}
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}

export function SettingsLegalDocumentExternalHeaderButton({
  externalUrl = LEGAL_URL,
}: {
  readonly externalUrl?: string;
}) {
  const safeExternalUrl = isLegalDocumentUrl(externalUrl) ? externalUrl : LEGAL_URL;

  return (
    <Pressable
      accessibilityLabel="Open legal documents in external browser"
      accessibilityRole="button"
      hitSlop={12}
      onPress={() => void Linking.openURL(safeExternalUrl).catch(() => undefined)}
      className="p-2 active:opacity-60"
    >
      <SymbolView
        name="safari"
        size={19}
        tintColorClassName={"accent-icon"}
        type="monochrome"
        weight="regular"
      />
    </Pressable>
  );
}
