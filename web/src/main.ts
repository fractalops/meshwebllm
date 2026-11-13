import { mount } from "svelte";
import App from "./App.svelte";
import "./style.css";
import "./network.css";

mount(App, { target: document.getElementById("app")! });
