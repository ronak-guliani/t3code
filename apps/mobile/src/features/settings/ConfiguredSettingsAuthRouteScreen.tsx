import { useAuth } from "@clerk/expo";
import { AuthView, UserProfileView } from "@clerk/expo/native";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useEffect, useRef } from "react";
import { View } from "react-native";

export default function ConfiguredSettingsAuthRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const navigation = useNavigation();
  const hasBeenSignedIn = useRef(isSignedIn);
  if (isSignedIn) {
    hasBeenSignedIn.current = true;
  }

  useEffect(() => {
    if (hasBeenSignedIn.current && isLoaded && isSignedIn === false) {
      navigation.dispatch(StackActions.popTo("SettingsContent"));
    }
  }, [isLoaded, isSignedIn, navigation]);

  return (
    <View collapsable={false} className="flex-1 overflow-hidden bg-sheet">
      {isLoaded ? (
        hasBeenSignedIn.current ? (
          <UserProfileView isDismissible={false} />
        ) : (
          <AuthView isDismissible={false} />
        )
      ) : null}
    </View>
  );
}
