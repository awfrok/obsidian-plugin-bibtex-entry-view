# Obsidian plugin bibtex entry view

## what is it

![sample.png](sample.png)

- If the plugin find the `bibtexkey` in the `.bib` file, the codeblock (first codeblock above) is replaced with the entry view of the `bibtexkey` (second codeblock).
- If the plugin cannot find the `bibtexkey` in the `.bib` file, the codeblock remains same with red colored text and canceled line (third codeblock).

## how to use

### in the note

- Use codeblock format as following.
````
```bibtexkey
{bibtexkey}
```
````

### in the settings 

- put the `.bib` file in the root of the vault. And, in the settings of the plugin, you can choose the `.bib` file.
- Or, make a symbolic link to the `.bib` file in the root of the vault. And, you can choose it in the settings of the plugin.

## license

MIT

