<script setup>
import { InboxOutlined } from "@ant-design/icons-vue";

defineProps({
  icon: { type: [Object, Function], default: () => InboxOutlined },
  title: { type: String, default: "" },
  desc: { type: String, default: "" },
});
</script>

<template src="./template.html"></template>

<style scoped src="./styles.css"></style>
