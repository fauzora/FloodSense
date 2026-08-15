import { createApp } from "vue";
import { createVuetify } from "vuetify";
import App from "./App.vue";
import "vuetify/styles";
import "./style.css";

const vuetify = createVuetify({
  theme: { defaultTheme: "dark" },
});

createApp(App).use(vuetify).mount("#app");
