<script lang="ts">
	import { text } from '#app/messages';
	let { name }: { name: string } = $props();
</script>

<h1>{text.hello}</h1><p>{text.welcome._({ name })}</p><footer>{text['footer.terms']}</footer>
