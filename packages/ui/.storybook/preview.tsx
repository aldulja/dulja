import type { Decorator, Preview } from "@storybook/react-vite";
import { DirectionProvider } from "../src/direction";
// `tailwind.css` pulls in `tokens.css` itself (see that file's header comment) — this is the one
// import that makes Tailwind utility classes resolve to real rules in the preview iframe.
import "../src/tailwind.css";

const withDirection: Decorator = (Story, context) => (
  <DirectionProvider locale={context.globals["locale"] === "ar" ? "ar" : "en"}>
    <Story />
  </DirectionProvider>
);

const preview: Preview = {
  decorators: [withDirection],
  globalTypes: {
    locale: {
      description: "Locale and text direction",
      defaultValue: "en",
      toolbar: {
        icon: "globe",
        items: [
          { value: "en", title: "English (ltr)" },
          { value: "ar", title: "العربية (rtl)" },
        ],
      },
    },
  },
};
export default preview;
