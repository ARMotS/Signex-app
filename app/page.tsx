import { redirect } from "next/navigation";

/**
 * There is one way in: the login. It sends an already signed-in user straight
 * on to their own screen, so / needs no page of its own.
 */
export default function Home() {
  redirect("/login");
}
