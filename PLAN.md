# Idea
A video game ranking app that helps you create a ranked list of all the video games you have ever played. To do this, the app presents you with two games, randomly chosen from IGDB or other source (perhaps starting with popular games). Perhaps you also first pick any platform you have ever played a game on, to filter out junk. 
For each comparison, you can:
 - say that you have never played one of the games, in which case it is replaced with another
 - choose which you think is the better game
Over time by doing this comparisons, a ranked list should be formed.

For unplayed games, two options: permanently ignore or backlog/play later.

The user should be able to see this ranked list either update in real time, or on another section of the app. They can then share this list, or a subset (e.g. top 10, top 100, best of 2021, etc.).

Perhaps the algorithm should be some variation of an array sort. Binary search? Insertion sort? These are just vague notions.

# Implementation
A prototype web app that can be hosted on GitHub pages. Stores the user's data using local storage (or something similar - not shared or on a server).

A sorting interface that shows the two games (with artwork?), where you either click on the preferred game, or skip it.

A list interface that shows your all the games you have ranked so far.
A list interface that shows your backlog.
A list interface that shows your ignored games.

The prototype is to validate the idea. The end goal is to create a native iOS app, so the quality of the prototype code or the tech used is not important.