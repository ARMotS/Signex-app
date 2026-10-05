import SignInScreen from "@/components/SignInScreen";

/**
 * Home: what Signex does, beside the one sign-in. Same screen as /login, so
 * there is still only one way in — an already signed-in visitor is sent
 * straight on to their own screen.
 */
export default function Home() {
  return <SignInScreen />;
}
