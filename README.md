# Obsidian.md plugin bibtex entry view

## what is it

![sample.png](sample.png)

What's in the `.bib` file
```
@MvReference{ReynoldsKJ-2015e-socialidentity,
  author           = {Reynolds, Katherine J,},
  booktitle        = {International Encyclopedia of the Social & Behavioral Sciences},
  citationkey      = {ReynoldsKJ-2015e-socialidentity},
  doi              = {10.1016/B978-0-08-097086-8.24064-6},
  edition          = {2nd},
  pages            = {313--318},
  title            = {Social Identity in Social Psychology},
  volume           = {22},
  year             = {2015},
  abstract         = {In this article different defniitions of social identity are outlined that include developmental and sociological approaches. The main focus of the article is on the concept of identity in social psychology and the social identity perspective specifcially. The psychological group and social identity processes are outlined along with the conditions that explain which of many identities (self-other similarity, self-stereotyping) will become salient. As part of this endeavor social identifciation and social identity salience are differentiated and implications for measurement are outlined. It is argued that social identity – the context specifci defniitions of who ‘we’ are and what ‘we’ do – both shape behavior and facilitate behavior change.},
  creationdate     = {2024-07-22T13:12:48},
  modificationdate = {2024-07-22T15:11:41},
}
```

- If the plugin find the `bibtexkey` in the `.bib` file, the codeblock (first codeblock above) is replaced with the entry view of the `bibtexkey` (second codeblock).
- If the plugin cannot find the `bibtexkey` in the `.bib` file, the codeblock remains same with red colored text and canceled line (third codeblock).

## how to use it

### in the note

- Write a codeblock in the following format
````
```bibtexkey
{bibtexkey}
```
````

### in the settings 

- Put the `.bib` file in the root of the vault. And, in the settings of the plugin, you can choose the `.bib` file.
- Or, make a symbolic link to the `.bib` file in the root of the vault. And, you can choose it in the settings of the plugin.

## what to do next

- Adding the option for Sorting the fields in the order of what a user chooses in the plugin settings.
- Adding the option for hiding the field that a user chooses in the plugin settings.

## license

MIT

